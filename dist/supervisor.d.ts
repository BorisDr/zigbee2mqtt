import { type FrontendHubLogger, type FrontendHubSettings } from "./frontendHub";
export interface InstanceDefinition {
    name: string;
    dataPath: string;
}
export interface InstancesConfig {
    frontend: Partial<FrontendHubSettings>;
    instances: InstanceDefinition[];
}
/** Messages sent from the supervisor to an instance worker. */
export type SupervisorToWorkerMessage = {
    type: "stop";
    signal?: NodeJS.Signals;
};
/** Messages sent from an instance worker to the supervisor. */
export type WorkerToSupervisorMessage = {
    type: "started";
};
export declare const INSTANCES_FILE = "instances.yaml";
export declare const INSTANCE_NAME_REGEX: RegExp;
/**
 * Determines whether Zigbee2MQTT should run in multi-coordinator mode and with which instances.
 *
 * - `ZIGBEE2MQTT_DATA` with several directories (separated by `path.delimiter` or `,`): one instance per directory, named after it.
 * - `instances.yaml` in the data directory: explicit instances (and combined frontend settings).
 * - otherwise: `undefined`, regular single-coordinator mode.
 */
export declare function resolveInstances(): InstancesConfig | undefined;
/**
 * Validates the configuration of all instances before starting anything: each must have an existing `configuration.yaml`
 * (the onboarding wizard is not available in multi-coordinator mode), and the resources that cannot be shared between
 * instances must not collide.
 */
export declare function preflight(config: InstancesConfig, logger: FrontendHubLogger): void;
/**
 * Runs one Zigbee2MQTT `Controller` per coordinator, each in its own `worker_threads` Worker with its own data directory
 * (and therefore configuration, database, state, logs, MQTT base topic), and serves a combined frontend for all of them.
 */
export declare class Supervisor {
    private readonly config;
    private readonly logger;
    private readonly watchdogDelays;
    private readonly exitCallback;
    private readonly hub;
    private readonly workers;
    private sdNotify;
    private stopping;
    /**
     * @param watchdogDelays When set, a crashed instance is restarted after these delays (in ms, one per successive
     * crash, giving up when exhausted). When unset, a crashed instance stops the whole supervisor (container restart semantics).
     */
    constructor(config: InstancesConfig, logger: FrontendHubLogger, watchdogDelays: number[] | undefined, exitCallback: (code: number) => void);
    start(): Promise<void>;
    stop(signal?: NodeJS.Signals): Promise<void>;
    /** Starts the worker of `definition`, resolves with `true` once it reported to be started, `false` if it exited before that. */
    private spawn;
    /** Prefixes every line logged by the worker with its instance name so the console output of all instances can be told apart. */
    private prefixOutput;
    private onWorkerExit;
    private stopWorker;
}
//# sourceMappingURL=supervisor.d.ts.map