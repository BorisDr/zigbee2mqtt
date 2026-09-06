/**
 * Entry point of an instance worker in multi-coordinator mode (see `Supervisor`).
 *
 * Runs a regular Zigbee2MQTT `Controller` for the data directory given in `ZIGBEE2MQTT_DATA`, in a `worker_threads` Worker
 * so that all module-level state (settings, data path, logger) is private to this instance.
 */
import { parentPort } from "node:worker_threads";
import { type InstanceContext } from "./util/instanceContext";
export declare function runWorker(context: InstanceContext, port: NonNullable<typeof parentPort>): Promise<void>;
//# sourceMappingURL=worker.d.ts.map