import {EventEmitter} from "node:events";
import type {MessagePort} from "node:worker_threads";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {getInstanceContext} from "../lib/util/instanceContext";
import {runWorker} from "../lib/worker";

const mockOnboard = vi.fn(async () => true);

vi.mock("../lib/util/onboarding", () => ({
    onboard: (): Promise<boolean> => mockOnboard(),
}));

const mockController = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async (_restart?: boolean, _code?: number, _signal?: NodeJS.Signals) => {}),
};
const mockControllerConstructor = vi.fn();

vi.mock("../lib/controller", () => ({
    Controller: vi
        .fn()
        .mockImplementation((restartCallback: () => Promise<void>, exitCallback: (code: number, restart: boolean) => Promise<void>) => {
            mockControllerConstructor(restartCallback, exitCallback);

            return mockController;
        }),
}));

describe("Worker", () => {
    const context = {name: "alpha", index: 0, frontendUrl: "http://z2m.local/"};
    let parentPort: EventEmitter & {postMessage: ReturnType<typeof vi.fn>};
    let processExit: ReturnType<typeof vi.spyOn>;
    let consoleError: ReturnType<typeof vi.spyOn>;
    const flush = async (): Promise<void> => {
        await new Promise((resolve) => setImmediate(resolve));
    };

    const callbacks = (): {restart: () => Promise<void>; exit: (code: number, restart?: boolean) => Promise<void>} => {
        const [restart, exit] = mockControllerConstructor.mock.calls[0];

        return {restart, exit};
    };

    beforeEach(() => {
        parentPort = Object.assign(new EventEmitter(), {postMessage: vi.fn()});
        processExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
        consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        mockOnboard.mockClear();
        mockOnboard.mockResolvedValue(true);
        mockController.start.mockClear();
        mockController.stop.mockClear();
        mockControllerConstructor.mockClear();
    });

    afterEach(() => {
        processExit.mockRestore();
        consoleError.mockRestore();
    });

    it("starts the controller and reports to the supervisor", async () => {
        await runWorker(context, parentPort as unknown as MessagePort);

        expect(getInstanceContext()).toStrictEqual(context);
        expect(mockOnboard).toHaveBeenCalledTimes(1);
        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(parentPort.postMessage).toHaveBeenCalledWith({type: "started"});
        expect(processExit).not.toHaveBeenCalled();

        // restart requested by the controller (e.g. `bridge/request/restart`)
        await callbacks().restart();
        expect(mockController.stop).toHaveBeenCalledWith(true);
        expect(mockController.start).toHaveBeenCalledTimes(2);
        expect(parentPort.postMessage).toHaveBeenCalledTimes(2);

        // exit with restart is a no-op (the restart callback takes over), otherwise ends the thread
        await callbacks().exit(0, true);
        expect(processExit).not.toHaveBeenCalled();
        await callbacks().exit(3);
        expect(processExit).toHaveBeenCalledWith(3);

        // stop requested by the supervisor
        parentPort.emit("message", {type: "stop", signal: "SIGTERM"});
        await flush();
        expect(mockController.stop).toHaveBeenCalledWith(false, undefined, "SIGTERM");
        parentPort.emit("message", {type: "other"});
    });

    it("exits when onboarding fails", async () => {
        mockOnboard.mockResolvedValue(false);

        await runWorker(context, parentPort as unknown as MessagePort);

        expect(mockControllerConstructor).not.toHaveBeenCalled();
        expect(processExit).toHaveBeenCalledWith(1);
        expect(parentPort.postMessage).not.toHaveBeenCalled();
    });

    it("exits when stopped before the controller exists or when stopping fails", async () => {
        let resolveOnboard: (value: boolean) => void = () => {};
        mockOnboard.mockImplementation(() => new Promise<boolean>((resolve) => (resolveOnboard = resolve)));

        const running = runWorker(context, parentPort as unknown as MessagePort);
        await flush();
        parentPort.emit("message", {type: "stop"});
        expect(processExit).toHaveBeenCalledWith(0);

        resolveOnboard(true);
        await running;

        mockController.stop.mockRejectedValueOnce(new Error("stop failed"));
        parentPort.emit("message", {type: "stop"});
        await flush();
        expect(consoleError).toHaveBeenCalledWith("Failed to stop: stop failed");
        expect(processExit).toHaveBeenCalledWith(1);
    });
});
