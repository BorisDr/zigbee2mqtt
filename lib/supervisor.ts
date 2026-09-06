import {existsSync} from "node:fs";
import path from "node:path";
import {createInterface} from "node:readline";
import {MessageChannel, Worker} from "node:worker_threads";
import {FrontendHub, type FrontendHubLogger, type FrontendHubSettings} from "./frontendHub";
import type {InstanceContext} from "./util/instanceContext";
import {initSdNotify} from "./util/sd-notify";
import yaml from "./util/yaml";

export interface InstanceDefinition {
    name: string;
    dataPath: string;
}

export interface InstancesConfig {
    frontend: Partial<FrontendHubSettings>;
    instances: InstanceDefinition[];
}

/** Messages sent from the supervisor to an instance worker. */
export type SupervisorToWorkerMessage = {type: "stop"; signal?: NodeJS.Signals};
/** Messages sent from an instance worker to the supervisor. */
export type WorkerToSupervisorMessage = {type: "started"};

export const INSTANCES_FILE = "instances.yaml";
export const INSTANCE_NAME_REGEX = /^[\w-]+$/;
/** Time given to a worker to stop gracefully before it is terminated. */
const STOP_TIMEOUT_MS = 60000;

interface ManagedWorker {
    definition: InstanceDefinition;
    index: number;
    worker: Worker;
    /** `true` once the supervisor asked the worker to stop (its exit is then expected). */
    solicitedStop: boolean;
    watchdogCount: number;
}

function defaultDataRoot(): string {
    return process.env.ZIGBEE2MQTT_DATA ? process.env.ZIGBEE2MQTT_DATA : path.normalize(path.join(__dirname, "..", "data"));
}

function validateInstances(instances: InstanceDefinition[]): void {
    const names = new Set<string>();
    const dataPaths = new Set<string>();

    for (const instance of instances) {
        if (!INSTANCE_NAME_REGEX.test(instance.name)) {
            throw new Error(`Invalid instance name '${instance.name}', allowed characters: letters, digits, '_' and '-'`);
        }

        if (names.has(instance.name)) {
            throw new Error(`Duplicate instance name '${instance.name}'`);
        }

        if (dataPaths.has(instance.dataPath)) {
            throw new Error(`Duplicate instance data directory '${instance.dataPath}'`);
        }

        names.add(instance.name);
        dataPaths.add(instance.dataPath);
    }
}

/**
 * Determines whether Zigbee2MQTT should run in multi-coordinator mode and with which instances.
 *
 * - `ZIGBEE2MQTT_DATA` with several directories (separated by `path.delimiter` or `,`): one instance per directory, named after it.
 * - `instances.yaml` in the data directory: explicit instances (and combined frontend settings).
 * - otherwise: `undefined`, regular single-coordinator mode.
 */
export function resolveInstances(): InstancesConfig | undefined {
    const dataRoot = defaultDataRoot();
    const dataDirs = dataRoot.split(new RegExp(`[${path.delimiter},]`)).filter((dir) => dir.trim() !== "");

    if (dataDirs.length > 1) {
        const instances = dataDirs.map((dir) => {
            const dataPath = path.resolve(dir.trim());

            return {name: path.basename(dataPath), dataPath};
        });

        validateInstances(instances);

        return {frontend: {}, instances};
    }

    const instancesFile = path.join(dataRoot, INSTANCES_FILE);

    if (!existsSync(instancesFile)) {
        return undefined;
    }

    const content = yaml.read(instancesFile);

    if (!Array.isArray(content.instances) || content.instances.length === 0) {
        throw new Error(`'${instancesFile}' must contain a non-empty 'instances' list`);
    }

    const instances: InstanceDefinition[] = content.instances.map((entry: KeyValue, i: number) => {
        if (typeof entry?.name !== "string" || typeof entry.data_dir !== "string") {
            throw new Error(`'${instancesFile}' instances[${i}] must have a 'name' and a 'data_dir'`);
        }

        return {name: entry.name, dataPath: path.resolve(dataRoot, entry.data_dir)};
    });

    validateInstances(instances);

    const frontend = content.frontend;

    if (frontend !== undefined && (typeof frontend !== "object" || frontend === null)) {
        throw new Error(`'${instancesFile}' 'frontend' must be an object`);
    }

    return {frontend: (frontend ?? {}) as Partial<FrontendHubSettings>, instances};
}

/**
 * Validates the configuration of all instances before starting anything: each must have an existing `configuration.yaml`
 * (the onboarding wizard is not available in multi-coordinator mode), and the resources that cannot be shared between
 * instances must not collide.
 */
export function preflight(config: InstancesConfig, logger: FrontendHubLogger): void {
    // setting -> value -> name of the instance using it
    const seen = {
        "serial.port": new Map<string, string>(),
        "mqtt.base_topic": new Map<string, string>(),
        "mqtt.client_id": new Map<string, string>(),
    };
    const check = (key: keyof typeof seen, value: unknown, instance: string): void => {
        if (typeof value !== "string" || value === "") {
            return;
        }

        const other = seen[key].get(value);

        if (other) {
            throw new Error(`Instances '${other}' and '${instance}' use the same ${key} '${value}'`);
        }

        seen[key].set(value, instance);
    };

    for (const instance of config.instances) {
        const configFile = path.join(instance.dataPath, "configuration.yaml");

        if (!existsSync(configFile)) {
            throw new Error(
                `Instance '${instance.name}' has no '${configFile}'. Create it first, e.g. by running Zigbee2MQTT once with ZIGBEE2MQTT_DATA=${instance.dataPath}`,
            );
        }

        const settings = yaml.read(configFile);

        check("serial.port", settings.serial?.port, instance.name);
        check("mqtt.base_topic", settings.mqtt?.base_topic ?? "zigbee2mqtt", instance.name);
        check("mqtt.client_id", settings.mqtt?.client_id, instance.name);

        if (settings.frontend?.enabled) {
            logger.info(`Instance '${instance.name}': 'frontend' settings are superseded by the combined frontend (multi-coordinator mode)`);
        }
    }
}

/**
 * Runs one Zigbee2MQTT `Controller` per coordinator, each in its own `worker_threads` Worker with its own data directory
 * (and therefore configuration, database, state, logs, MQTT base topic), and serves a combined frontend for all of them.
 */
export class Supervisor {
    private readonly config: InstancesConfig;
    private readonly logger: FrontendHubLogger;
    private readonly watchdogDelays: number[] | undefined;
    private readonly exitCallback: (code: number) => void;
    private readonly hub: FrontendHub;
    private readonly workers = new Map<string, ManagedWorker>();
    private sdNotify: Awaited<ReturnType<typeof initSdNotify>>;
    private stopping = false;

    /**
     * @param watchdogDelays When set, a crashed instance is restarted after these delays (in ms, one per successive
     * crash, giving up when exhausted). When unset, a crashed instance stops the whole supervisor (container restart semantics).
     */
    constructor(config: InstancesConfig, logger: FrontendHubLogger, watchdogDelays: number[] | undefined, exitCallback: (code: number) => void) {
        this.config = config;
        this.logger = logger;
        this.watchdogDelays = watchdogDelays;
        this.exitCallback = exitCallback;
        this.hub = new FrontendHub(config.frontend, config.instances, logger);
    }

    async start(): Promise<void> {
        this.logger.info(`Starting ${this.config.instances.length} Zigbee2MQTT instances: ${this.config.instances.map((i) => i.name).join(", ")}`);

        await this.hub.start();

        const started: Promise<boolean>[] = [];

        for (const [index, definition] of this.config.instances.entries()) {
            started.push(this.spawn(definition, index, 0));
        }

        if ((await Promise.all(started)).every((ok) => ok)) {
            this.logger.info("All Zigbee2MQTT instances started");
        }

        if (!this.stopping) {
            this.sdNotify = await initSdNotify();
        }
    }

    async stop(signal?: NodeJS.Signals): Promise<void> {
        this.stopping = true;
        this.sdNotify?.notifyStopping();

        await Promise.all([...this.workers.values()].map((managed) => this.stopWorker(managed, signal)));
        await this.hub.stop();
        this.sdNotify?.stop();
    }

    /** Starts the worker of `definition`, resolves with `true` once it reported to be started, `false` if it exited before that. */
    private spawn(definition: InstanceDefinition, index: number, watchdogCount: number): Promise<boolean> {
        const {port1, port2} = new MessageChannel();
        const workerData: InstanceContext = {name: definition.name, index, frontendPort: port2, frontendUrl: this.config.frontend.url};
        const env: NodeJS.ProcessEnv = {...process.env, ZIGBEE2MQTT_DATA: definition.dataPath, Z2M_ONBOARD_NO_SERVER: "1"};

        // systemd notifications are handled by the supervisor only
        delete env.NOTIFY_SOCKET;
        delete env.WATCHDOG_USEC;

        const worker = new Worker(path.join(__dirname, "worker.js"), {workerData, transferList: [port2], env, stdout: true, stderr: true});
        const managed: ManagedWorker = {definition, index, worker, solicitedStop: false, watchdogCount};

        this.workers.set(definition.name, managed);
        this.hub.attach(definition.name, port1);
        this.prefixOutput(definition.name, worker);

        return new Promise<boolean>((resolve) => {
            worker.on("message", (message: WorkerToSupervisorMessage) => {
                if (message.type === "started") {
                    this.logger.info(`Instance '${definition.name}' started`);
                    managed.watchdogCount = 0;
                    resolve(true);
                }
            });
            worker.on("error", (error: Error) => {
                this.logger.error(`Instance '${definition.name}' failed: ${error.stack ?? error.message}`);
            });
            worker.on("exit", (code) => {
                resolve(false);
                this.onWorkerExit(managed, code).catch((error: Error) =>
                    this.logger.error(`Failed to handle exit of '${definition.name}': ${error.message}`),
                );
            });
        });
    }

    /** Prefixes every line logged by the worker with its instance name so the console output of all instances can be told apart. */
    private prefixOutput(name: string, worker: Worker): void {
        for (const [stream, output] of [
            [worker.stdout, process.stdout],
            [worker.stderr, process.stderr],
        ] as const) {
            createInterface({input: stream}).on("line", (line) => {
                output.write(`[${name}] ${line}\n`);
            });
        }
    }

    private async onWorkerExit(managed: ManagedWorker, code: number): Promise<void> {
        const {name} = managed.definition;

        if (this.workers.get(name) === managed) {
            this.workers.delete(name);
        }

        this.hub.detach(name);

        if (managed.solicitedStop || this.stopping) {
            this.logger.info(`Instance '${name}' stopped (code=${code})`);

            return;
        }

        this.logger.error(`Instance '${name}' exited unexpectedly (code=${code})`);

        const delay = this.watchdogDelays?.[managed.watchdogCount];

        if (delay !== undefined) {
            this.logger.info(`WATCHDOG: Waiting ${delay / 60000}min before restarting instance '${name}'`);

            await new Promise((resolve) => setTimeout(resolve, delay));

            if (!this.stopping) {
                await this.spawn(managed.definition, managed.index, managed.watchdogCount + 1);
            }
        } else {
            this.logger.error(`Instance '${name}' cannot be recovered, stopping all instances`);

            await this.stop();
            this.exitCallback(code === 0 ? 1 : code);
        }
    }

    private async stopWorker(managed: ManagedWorker, signal?: NodeJS.Signals): Promise<void> {
        managed.solicitedStop = true;

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                this.logger.error(`Instance '${managed.definition.name}' did not stop in time, terminating`);
                managed.worker.terminate().finally(resolve);
            }, STOP_TIMEOUT_MS);

            managed.worker.once("exit", () => {
                clearTimeout(timeout);
                resolve();
            });

            const message: SupervisorToWorkerMessage = {type: "stop", signal};

            managed.worker.postMessage(message);
        });
    }
}
