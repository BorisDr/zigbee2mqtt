/**
 * Entry point of an instance worker in multi-coordinator mode (see `Supervisor`).
 *
 * Runs a regular Zigbee2MQTT `Controller` for the data directory given in `ZIGBEE2MQTT_DATA`, in a `worker_threads` Worker
 * so that all module-level state (settings, data path, logger) is private to this instance.
 */
import {isMainThread, parentPort, workerData} from "node:worker_threads";
import type {SupervisorToWorkerMessage, WorkerToSupervisorMessage} from "./supervisor";
import {type InstanceContext, setInstanceContext} from "./util/instanceContext";

export async function runWorker(context: InstanceContext, port: NonNullable<typeof parentPort>): Promise<void> {
    setInstanceContext(context);

    const {onboard} = await import("./util/onboarding.js");
    const {Controller} = await import("./controller.js");
    const post = (message: WorkerToSupervisorMessage): void => port.postMessage(message);
    let controller: InstanceType<typeof Controller> | undefined;

    const exit = (code: number, restart = false): Promise<void> => {
        if (!restart) {
            // ends only this worker thread, the supervisor decides what to do based on the exit code
            process.exit(code);
        }

        return Promise.resolve();
    };

    const start = async (): Promise<void> => {
        if (!(await onboard())) {
            return await exit(1);
        }

        controller = new Controller(restart, exit);

        await controller.start();

        post({type: "started"});
    };

    const restart = async (): Promise<void> => {
        await controller?.stop(true);
        await start();
    };

    port.on("message", (message: SupervisorToWorkerMessage) => {
        if (message.type === "stop") {
            if (controller) {
                controller.stop(false, undefined, message.signal).catch((error: Error) => {
                    console.error(`Failed to stop: ${error.message}`);
                    process.exit(1);
                });
            } else {
                process.exit(0);
            }
        }
    });

    await start();
}

/* v8 ignore start */
if (!isMainThread && parentPort) {
    runWorker(workerData as InstanceContext, parentPort).catch((error: Error) => {
        console.error(`Failed to start instance: ${error.stack ?? error.message}`);
        process.exit(1);
    });
}
/* v8 ignore stop */
