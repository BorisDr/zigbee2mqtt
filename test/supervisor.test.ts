// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import tmp from "tmp";
import yaml from "../lib/util/yaml";

const mockHub = {
    start: vi.fn<() => Promise<void>>(async () => {}),
    stop: vi.fn<() => Promise<void>>(async () => {}),
    attach: vi.fn(),
    detach: vi.fn(),
};

vi.mock("../lib/frontendHub", () => ({
    FrontendHub: vi.fn().mockImplementation(() => mockHub),
}));

const mockSdNotify = {notifyStopping: vi.fn(), stop: vi.fn()};
const mockInitSdNotify = vi.fn(async () => mockSdNotify);

vi.mock("../lib/util/sd-notify", () => ({
    initSdNotify: (): Promise<typeof mockSdNotify> => mockInitSdNotify(),
}));

const {MockWorker} = vi.hoisted(() => {
    const {EventEmitter} = require("node:events") as typeof import("node:events");
    const {PassThrough} = require("node:stream") as typeof import("node:stream");

    class MockWorker extends EventEmitter {
        static instances: MockWorker[] = [];
        file: string;
        options: {workerData: KeyValue; transferList: unknown[]; env: NodeJS.ProcessEnv; stdout: boolean; stderr: boolean};
        stdout = new PassThrough();
        stderr = new PassThrough();
        postMessage = vi.fn();
        terminate = vi.fn(() => {
            this.emit("exit", 1);

            return Promise.resolve(1);
        });

        constructor(file: string, options: MockWorker["options"]) {
            super();
            this.file = file;
            this.options = options;
            MockWorker.instances.push(this);
        }

        started(): void {
            this.emit("message", {type: "started"});
        }
    }

    return {MockWorker};
});

vi.mock("node:worker_threads", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    Worker: MockWorker,
}));

import {INSTANCES_FILE, type InstancesConfig, preflight, resolveInstances, Supervisor} from "../lib/supervisor";

describe("Supervisor", () => {
    const logger = {info: vi.fn(), warning: vi.fn(), error: vi.fn()};
    const originalEnv = {...process.env};
    let dataRoot: string;

    const writeConfig = (dir: string, config: KeyValue): void => {
        fs.mkdirSync(dir, {recursive: true});
        yaml.writeIfChanged(path.join(dir, "configuration.yaml"), config);
    };

    beforeEach(() => {
        dataRoot = tmp.dirSync().name;
        process.env = {...originalEnv, ZIGBEE2MQTT_DATA: dataRoot};
        delete process.env.NOTIFY_SOCKET;
        delete process.env.WATCHDOG_USEC;
        MockWorker.instances = [];

        for (const mock of [
            mockHub.start,
            mockHub.stop,
            mockHub.attach,
            mockHub.detach,
            mockInitSdNotify,
            logger.info,
            logger.warning,
            logger.error,
        ]) {
            mock.mockClear();
        }
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe("resolveInstances", () => {
        it("returns nothing in single-coordinator mode", () => {
            expect(resolveInstances()).toBeUndefined();

            delete process.env.ZIGBEE2MQTT_DATA;
            expect(resolveInstances()).toBeUndefined();
        });

        it.each([path.delimiter, ","])("resolves instances from a list of data directories (separator '%s')", (separator) => {
            const a = path.join(dataRoot, "alpha");
            const b = path.join(dataRoot, "beta");
            process.env.ZIGBEE2MQTT_DATA = ` ${a}${separator}${b}${separator}`;

            expect(resolveInstances()).toStrictEqual({
                frontend: {},
                instances: [
                    {name: "alpha", dataPath: a},
                    {name: "beta", dataPath: b},
                ],
            });
        });

        it("rejects duplicate data directories in a list", () => {
            const a = path.join(dataRoot, "alpha");
            process.env.ZIGBEE2MQTT_DATA = `${a},${a}`;

            expect(() => resolveInstances()).toThrow("Duplicate instance name 'alpha'");

            process.env.ZIGBEE2MQTT_DATA = `${a},${path.join(dataRoot, "sub", "alpha")}`;
            expect(() => resolveInstances()).toThrow("Duplicate instance name 'alpha'");
        });

        it("resolves instances from instances.yaml", () => {
            // absolute (including the drive on Windows) and outside of the data root: used as-is
            const garage = path.resolve(dataRoot, "..", "garage");

            yaml.writeIfChanged(path.join(dataRoot, INSTANCES_FILE), {
                frontend: {port: 8099, url: "http://z2m.local:8099/"},
                instances: [
                    {name: "living_room", data_dir: "living_room"},
                    {name: "garage", data_dir: garage},
                ],
            });

            expect(resolveInstances()).toStrictEqual({
                frontend: {port: 8099, url: "http://z2m.local:8099/"},
                instances: [
                    {name: "living_room", dataPath: path.join(dataRoot, "living_room")},
                    {name: "garage", dataPath: garage},
                ],
            });

            // frontend is optional
            yaml.writeIfChanged(path.join(dataRoot, INSTANCES_FILE), {instances: [{name: "solo", data_dir: "solo"}]});
            expect(resolveInstances()).toStrictEqual({frontend: {}, instances: [{name: "solo", dataPath: path.join(dataRoot, "solo")}]});
        });

        it.each([
            [{instances: []}, "must contain a non-empty 'instances' list"],
            [{frontend: {}}, "must contain a non-empty 'instances' list"],
            [{instances: [{name: "a"}]}, "instances[0] must have a 'name' and a 'data_dir'"],
            [{instances: [{name: "a", data_dir: "a"}, "b"]}, "instances[1] must have a 'name' and a 'data_dir'"],
            [{instances: [{name: "a b", data_dir: "a"}]}, "Invalid instance name 'a b', allowed characters: letters, digits, '_' and '-'"],
            [
                {
                    instances: [
                        {name: "a", data_dir: "a"},
                        {name: "a", data_dir: "b"},
                    ],
                },
                "Duplicate instance name 'a'",
            ],
            [
                {
                    instances: [
                        {name: "a", data_dir: "same"},
                        {name: "b", data_dir: "same"},
                    ],
                },
                `Duplicate instance data directory '${path.join("%ROOT%", "same")}'`,
            ],
            [{instances: [{name: "a", data_dir: "a"}], frontend: "nope"}, "'frontend' must be an object"],
        ])("rejects invalid instances.yaml %j", (content, error) => {
            yaml.writeIfChanged(path.join(dataRoot, INSTANCES_FILE), content);

            expect(() => resolveInstances()).toThrow(error.replace("%ROOT%", dataRoot));
        });
    });

    describe("preflight", () => {
        let config: InstancesConfig;

        beforeEach(() => {
            config = {
                frontend: {},
                instances: [
                    {name: "alpha", dataPath: path.join(dataRoot, "alpha")},
                    {name: "beta", dataPath: path.join(dataRoot, "beta")},
                ],
            };
            writeConfig(config.instances[0].dataPath, {mqtt: {base_topic: "z2m_a", client_id: "a"}, serial: {port: "/dev/ttyA"}});
            writeConfig(config.instances[1].dataPath, {mqtt: {base_topic: "z2m_b"}, serial: {port: "/dev/ttyB"}, frontend: {enabled: true}});
        });

        it("accepts distinct instances", () => {
            expect(() => preflight(config, logger)).not.toThrow();
            expect(logger.info).toHaveBeenCalledWith(
                "Instance 'beta': 'frontend' settings are superseded by the combined frontend (multi-coordinator mode)",
            );
        });

        it("requires an existing configuration", () => {
            fs.rmSync(path.join(config.instances[1].dataPath, "configuration.yaml"));

            expect(() => preflight(config, logger)).toThrow(
                `Instance 'beta' has no '${path.join(config.instances[1].dataPath, "configuration.yaml")}'. Create it first, e.g. by running Zigbee2MQTT once with ZIGBEE2MQTT_DATA=${config.instances[1].dataPath}`,
            );
        });

        it.each([
            [
                {mqtt: {base_topic: "z2m_a", client_id: "a"}, serial: {port: "/dev/ttyA"}},
                {mqtt: {base_topic: "z2m_a"}, serial: {port: "/dev/ttyB"}},
                "Instances 'alpha' and 'beta' use the same mqtt.base_topic 'z2m_a'",
            ],
            [
                {mqtt: {base_topic: "z2m_a", client_id: "a"}, serial: {port: "/dev/ttyA"}},
                {mqtt: {base_topic: "z2m_b"}, serial: {port: "/dev/ttyA"}},
                "Instances 'alpha' and 'beta' use the same serial.port '/dev/ttyA'",
            ],
            [
                {mqtt: {base_topic: "z2m_a", client_id: "a"}, serial: {port: "/dev/ttyA"}},
                {mqtt: {base_topic: "z2m_b", client_id: "a"}, serial: {port: "/dev/ttyB"}},
                "Instances 'alpha' and 'beta' use the same mqtt.client_id 'a'",
            ],
            [
                {mqtt: {server: "mqtt://a"}, serial: {port: "/dev/ttyA"}},
                {mqtt: {server: "mqtt://b"}, serial: {port: "/dev/ttyB"}},
                "Instances 'alpha' and 'beta' use the same mqtt.base_topic 'zigbee2mqtt'",
            ],
        ])("rejects colliding settings %j %j", (alphaConfig, betaConfig, error) => {
            writeConfig(config.instances[0].dataPath, alphaConfig);
            writeConfig(config.instances[1].dataPath, betaConfig);

            expect(() => preflight(config, logger)).toThrow(error);
        });

        it("ignores missing or empty values", () => {
            writeConfig(config.instances[0].dataPath, {mqtt: {base_topic: "a", client_id: ""}});
            writeConfig(config.instances[1].dataPath, {mqtt: {base_topic: "b", client_id: ""}, serial: {port: null}});

            expect(() => preflight(config, logger)).not.toThrow();
        });
    });

    describe("Supervisor", () => {
        const exitCallback = vi.fn();
        let config: InstancesConfig;
        let supervisor: Supervisor;
        let stdoutWrite: ReturnType<typeof vi.spyOn>;
        let stderrWrite: ReturnType<typeof vi.spyOn>;

        const flush = async (): Promise<void> => {
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
        };

        beforeAll(() => {
            vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        beforeEach(() => {
            exitCallback.mockClear();
            process.env.NOTIFY_SOCKET = "/run/systemd/notify";
            process.env.WATCHDOG_USEC = "1000";
            config = {
                frontend: {url: "http://z2m.local/"},
                instances: [
                    {name: "alpha", dataPath: path.join(dataRoot, "alpha")},
                    {name: "beta", dataPath: path.join(dataRoot, "beta")},
                ],
            };
            stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
            stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        });

        afterEach(() => {
            stdoutWrite.mockRestore();
            stderrWrite.mockRestore();
        });

        it("starts and stops all instances", async () => {
            supervisor = new Supervisor(config, logger, undefined, exitCallback);
            const started = supervisor.start();

            await flush();
            expect(mockHub.start).toHaveBeenCalledTimes(1);
            expect(MockWorker.instances).toHaveLength(2);

            const [alpha, beta] = MockWorker.instances;
            expect(alpha.file).toStrictEqual(path.join(__dirname, "..", "lib", "worker.js"));
            expect(alpha.options.workerData).toStrictEqual({
                name: "alpha",
                index: 0,
                frontendPort: expect.any(Object),
                frontendUrl: "http://z2m.local/",
            });
            expect(alpha.options.transferList).toStrictEqual([alpha.options.workerData.frontendPort]);
            expect(alpha.options.env.ZIGBEE2MQTT_DATA).toStrictEqual(config.instances[0].dataPath);
            expect(alpha.options.env.Z2M_ONBOARD_NO_SERVER).toStrictEqual("1");
            expect(alpha.options.env.NOTIFY_SOCKET).toBeUndefined();
            expect(alpha.options.env.WATCHDOG_USEC).toBeUndefined();
            expect(alpha.options.stdout).toStrictEqual(true);
            expect(beta.options.workerData).toStrictEqual({
                name: "beta",
                index: 1,
                frontendPort: expect.any(Object),
                frontendUrl: "http://z2m.local/",
            });
            expect(mockHub.attach).toHaveBeenCalledWith("alpha", expect.any(Object));
            expect(mockHub.attach).toHaveBeenCalledWith("beta", expect.any(Object));
            expect(mockInitSdNotify).not.toHaveBeenCalled();

            // output of the workers is prefixed with the instance name
            alpha.stdout.write("hello\nworld\n");
            beta.stderr.write("oops\n");
            await flush();
            expect(stdoutWrite).toHaveBeenCalledWith("[alpha] hello\n");
            expect(stdoutWrite).toHaveBeenCalledWith("[alpha] world\n");
            expect(stderrWrite).toHaveBeenCalledWith("[beta] oops\n");

            alpha.started();
            beta.emit("message", {type: "other"});
            beta.started();
            await started;
            expect(logger.info).toHaveBeenCalledWith("Instance 'alpha' started");
            expect(logger.info).toHaveBeenCalledWith("All Zigbee2MQTT instances started");
            expect(mockInitSdNotify).toHaveBeenCalledTimes(1);

            const stopped = supervisor.stop("SIGINT");
            await flush();
            expect(mockSdNotify.notifyStopping).toHaveBeenCalledTimes(1);
            expect(alpha.postMessage).toHaveBeenCalledWith({type: "stop", signal: "SIGINT"});
            expect(beta.postMessage).toHaveBeenCalledWith({type: "stop", signal: "SIGINT"});
            alpha.emit("exit", 0);
            // beta does not stop in time
            await vi.advanceTimersByTimeAsync(60000);
            expect(beta.terminate).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith("Instance 'beta' did not stop in time, terminating");
            await stopped;
            expect(logger.info).toHaveBeenCalledWith("Instance 'alpha' stopped (code=0)");
            expect(logger.info).toHaveBeenCalledWith("Instance 'beta' stopped (code=1)");
            expect(mockHub.detach).toHaveBeenCalledWith("alpha");
            expect(mockHub.detach).toHaveBeenCalledWith("beta");
            expect(mockHub.stop).toHaveBeenCalledTimes(1);
            expect(mockSdNotify.stop).toHaveBeenCalledTimes(1);
            expect(exitCallback).not.toHaveBeenCalled();
        });

        it("stops everything when an instance fails without watchdog", async () => {
            supervisor = new Supervisor(config, logger, undefined, exitCallback);
            const started = supervisor.start();

            await flush();
            const [alpha, beta] = MockWorker.instances;
            alpha.started();
            beta.emit("error", new Error("crashed"));
            const noStack = new Error("no stack");
            noStack.stack = undefined;
            beta.emit("error", noStack);
            beta.emit("exit", 1);
            await flush();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Instance 'beta' failed: Error: crashed"));
            expect(logger.error).toHaveBeenCalledWith("Instance 'beta' failed: no stack");
            expect(logger.error).toHaveBeenCalledWith("Instance 'beta' exited unexpectedly (code=1)");
            expect(logger.error).toHaveBeenCalledWith("Instance 'beta' cannot be recovered, stopping all instances");
            expect(alpha.postMessage).toHaveBeenCalledWith({type: "stop", signal: undefined});
            alpha.emit("exit", 0);
            await flush();
            await started;
            expect(logger.info).not.toHaveBeenCalledWith("All Zigbee2MQTT instances started");
            expect(mockInitSdNotify).not.toHaveBeenCalled();
            expect(exitCallback).toHaveBeenCalledWith(1);

            // exit code 0 while not asked to stop is still a failure
            MockWorker.instances = [];
            exitCallback.mockClear();
            supervisor = new Supervisor({...config, instances: [config.instances[0]]}, logger, undefined, exitCallback);
            void supervisor.start();
            await flush();
            MockWorker.instances[0].started();
            MockWorker.instances[0].emit("exit", 0);
            await flush();
            expect(exitCallback).toHaveBeenCalledWith(1);
        });

        it("restarts a failed instance with watchdog", async () => {
            supervisor = new Supervisor(config, logger, [2000, 60000], exitCallback);
            const started = supervisor.start();

            await flush();
            const [alpha, beta] = MockWorker.instances;
            alpha.started();
            beta.started();
            await started;

            // first crash
            beta.emit("exit", 1);
            await flush();
            expect(mockHub.detach).toHaveBeenCalledWith("beta");
            expect(logger.info).toHaveBeenCalledWith("WATCHDOG: Waiting 0.03333333333333333min before restarting instance 'beta'");
            expect(MockWorker.instances).toHaveLength(2);
            await vi.advanceTimersByTimeAsync(2000);
            expect(MockWorker.instances).toHaveLength(3);
            const beta2 = MockWorker.instances[2];
            expect(beta2.options.workerData).toStrictEqual({
                name: "beta",
                index: 1,
                frontendPort: expect.any(Object),
                frontendUrl: "http://z2m.local/",
            });
            expect(mockHub.attach).toHaveBeenCalledTimes(3);

            // second crash before reporting started: next delay
            beta2.emit("exit", 1);
            await flush();
            expect(logger.info).toHaveBeenCalledWith("WATCHDOG: Waiting 1min before restarting instance 'beta'");
            await vi.advanceTimersByTimeAsync(60000);
            const beta3 = MockWorker.instances[3];
            beta3.started();

            // successful start resets the watchdog
            beta3.emit("exit", 1);
            await flush();
            expect(logger.info).toHaveBeenLastCalledWith("WATCHDOG: Waiting 0.03333333333333333min before restarting instance 'beta'");
            await vi.advanceTimersByTimeAsync(2000);
            const beta4 = MockWorker.instances[4];
            beta4.emit("exit", 1);
            await flush();
            await vi.advanceTimersByTimeAsync(60000);
            const beta5 = MockWorker.instances[5];

            // delays exhausted
            beta5.emit("exit", 2);
            await flush();
            expect(logger.error).toHaveBeenCalledWith("Instance 'beta' cannot be recovered, stopping all instances");
            alpha.emit("exit", 0);
            await flush();
            expect(exitCallback).toHaveBeenCalledWith(2);
            expect(MockWorker.instances).toHaveLength(6);
        });

        it("does not restart an instance when stopping during the watchdog delay", async () => {
            supervisor = new Supervisor(config, logger, [2000], exitCallback);
            const started = supervisor.start();

            await flush();
            const [alpha, beta] = MockWorker.instances;
            alpha.started();
            beta.started();
            await started;

            beta.emit("exit", 1);
            await flush();
            const stopped = supervisor.stop();
            await flush();
            alpha.emit("exit", 0);
            await stopped;
            await vi.advanceTimersByTimeAsync(2000);
            expect(MockWorker.instances).toHaveLength(2);
            expect(exitCallback).not.toHaveBeenCalled();
        });

        it("logs failures while handling an exit", async () => {
            supervisor = new Supervisor(config, logger, undefined, exitCallback);
            const started = supervisor.start();

            await flush();
            const [alpha, beta] = MockWorker.instances;
            alpha.started();
            beta.started();
            await started;
            mockHub.detach.mockImplementationOnce(() => {
                throw new Error("detach failed");
            });
            alpha.emit("exit", 0);
            await flush();
            expect(logger.error).toHaveBeenCalledWith("Failed to handle exit of 'alpha': detach failed");
        });
    });
});
