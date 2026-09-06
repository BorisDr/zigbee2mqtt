// biome-ignore assist/source/organizeImports: import mocks first
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {EventHandler} from "./mocks/utils";

import fs from "node:fs";
import path from "node:path";
import {MessageChannel, type MessagePort} from "node:worker_threads";
import tmp from "tmp";
import type {Mock} from "vitest";
import ws from "ws";
import {FrontendHub} from "../lib/frontendHub";
import type {HubToInstanceMessage} from "../lib/util/instanceContext";

const mockRedirectResponse = {
    writeHead: vi.fn<(statusCode: number, headers: Record<string, string | number>) => void>(),
    end: vi.fn<(data?: string) => void>(),
};

let mockHTTPOnRequest: (request: {url: string}, response: number | typeof mockRedirectResponse) => void;
const mockHTTPEvents: Record<string, EventHandler> = {};
const mockHTTP = {
    listen: vi.fn(),
    on: (event: string, handler: EventHandler): void => {
        mockHTTPEvents[event] = handler;
    },
    close: vi.fn<(cb: (err?: Error) => void) => void>((cb) => cb()),
};
const mockHTTPS = {
    listen: vi.fn(),
    on: vi.fn(),
    close: vi.fn<(cb: (err?: Error) => void) => void>((cb) => cb()),
};

class MockWebSocket {
    static OPEN = "open";
    readyState = "open";
    events: Record<string, EventHandler> = {};
    send = vi.fn<(data: string) => void>();
    close = vi.fn<(code?: number, reason?: string) => void>((): void => {
        this.readyState = "closed";
        this.events.close?.();
    });

    on(event: string, handler: EventHandler): void {
        this.events[event] = handler;
    }
}

const mockWS = {
    handleUpgrade: vi.fn().mockImplementation((_request, _socket, _head, cb) => {
        cb(new MockWebSocket());
    }),
    close: vi.fn(),
};

const frontendPath = tmp.dirSync().name;
const envsFile = "envs-AbC123_-.js";
let mockNodeStatic: {[s: string]: Mock} = {};
const mockSendNotFound = vi.fn();

vi.mock("node:http", () => ({
    createServer: vi.fn().mockImplementation((onRequest) => {
        mockHTTPOnRequest = onRequest;
        return mockHTTP;
    }),
}));

vi.mock("node:https", () => ({
    createServer: vi.fn().mockImplementation(() => mockHTTPS),
}));

vi.mock("../lib/util/staticFileServer", () => ({
    createStaticFileServer: vi.fn().mockImplementation((path: string) => {
        mockNodeStatic[path] = vi.fn();
        return mockNodeStatic[path];
    }),
    sendNotFound: vi.fn().mockImplementation((...args: unknown[]) => mockSendNotFound(...args)),
}));

vi.mock("zigbee2mqtt-windfront", () => ({
    default: {
        getPath: (): string => frontendPath,
    },
}));

vi.mock("ws", () => ({
    default: {
        OPEN: "open",
        Server: vi.fn().mockImplementation(() => mockWS),
    },
}));

describe("FrontendHub", () => {
    const logger = {info: vi.fn(), warning: vi.fn(), error: vi.fn()};
    const instanceA = {name: "alpha", dataPath: tmp.dirSync().name};
    const instanceB = {name: "beta", dataPath: tmp.dirSync().name};
    const instances = [instanceA, instanceB];
    let hub: FrontendHub;
    let channel: MessageChannel;
    /** Messages received by the (fake) instance side of the channel. */
    let instanceMessages: HubToInstanceMessage[];

    const writeEnvsModule = (): void => {
        fs.mkdirSync(path.join(frontendPath, "assets"), {recursive: true});
        fs.writeFileSync(
            path.join(frontendPath, "assets", envsFile),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholders as shipped by the frontend
            'const _="${Z2M_API_URLS}",s="${Z2M_API_NAMES}",A="${USE_PROXY}";export{A as U,s as Z,_ as a};',
        );
    };

    const upgrade = (url: string): MockWebSocket | undefined => {
        const socket = {destroy: vi.fn()};

        mockWS.handleUpgrade.mockClear();
        mockHTTPEvents.upgrade({url}, socket, Buffer.alloc(0));

        if (socket.destroy.mock.calls.length > 0) {
            expect(mockWS.handleUpgrade).not.toHaveBeenCalled();

            return undefined;
        }

        // the websocket created by `handleUpgrade`
        return mockWS.handleUpgrade.mock.results.length > 0 ? lastCreatedWebSocket() : undefined;
    };

    const createdWebSockets: MockWebSocket[] = [];
    const lastCreatedWebSocket = (): MockWebSocket => createdWebSockets[createdWebSockets.length - 1];

    /** MessagePort messages are delivered asynchronously, wait until the instance side received `count` messages. */
    const flush = async (count = instanceMessages.length): Promise<void> => {
        await vi.waitFor(() => expect(instanceMessages.length).toBeGreaterThanOrEqual(count));
        await new Promise((resolve) => setTimeout(resolve, 5));
    };

    beforeEach(() => {
        mockNodeStatic = {};
        createdWebSockets.length = 0;
        mockWS.handleUpgrade.mockImplementation((_request, _socket, _head, cb) => {
            const socket = new MockWebSocket();
            createdWebSockets.push(socket);
            cb(socket);
        });

        for (const mock of [
            mockHTTP.listen,
            mockHTTP.close,
            mockHTTPS.listen,
            mockHTTPS.close,
            mockWS.close,
            mockSendNotFound,
            mockRedirectResponse.writeHead,
            mockRedirectResponse.end,
            logger.info,
            logger.error,
        ]) {
            mock.mockClear();
        }

        fs.rmSync(frontendPath, {recursive: true, force: true});
        writeEnvsModule();

        channel = new MessageChannel();
        instanceMessages = [];
        channel.port2.on("message", (message: HubToInstanceMessage) => instanceMessages.push(message));
    });

    afterEach(async () => {
        await hub?.stop();
        channel.port2.close();
    });

    it("serves the frontend, the generated runtime configuration and device icons", async () => {
        fs.mkdirSync(path.join(instanceB.dataPath, "device_icons"), {recursive: true});
        fs.writeFileSync(path.join(instanceB.dataPath, "device_icons", "my_device.png"), "");
        hub = new FrontendHub({port: 8099}, instances, logger);
        await hub.start();

        expect(mockHTTP.listen).toHaveBeenCalledWith(8099);
        expect(logger.info).toHaveBeenCalledWith("Started combined frontend on port 8099");
        expect(Object.keys(mockNodeStatic)).toStrictEqual([
            frontendPath,
            path.join(instanceA.dataPath, "device_icons"),
            path.join(instanceB.dataPath, "device_icons"),
        ]);

        // regular files
        mockHTTPOnRequest({url: "/index.html"}, 2);
        expect(mockNodeStatic[frontendPath]).toHaveBeenCalledWith({url: "/index.html"}, 2);

        // runtime configuration of the frontend, API URLs are computed in the browser relative to the page
        mockHTTPOnRequest({url: `/assets/${envsFile}`}, mockRedirectResponse);
        expect(mockRedirectResponse.writeHead).toHaveBeenCalledWith(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Content-Length": expect.any(Number),
            "Cache-Control": "no-store",
        });
        expect(mockRedirectResponse.end).toHaveBeenCalledWith(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: generated JavaScript evaluated in the browser
            'const _=["alpha","beta"].map((n)=>`${window.location.host}${window.location.pathname.replace(/\\/+$/,"")}/${n}/api`).join(","),s="alpha,beta",A="false";export{A as U,s as Z,_ as a};',
        );
        expect(mockRedirectResponse.writeHead.mock.calls[0][1]["Content-Length"]).toStrictEqual(
            Buffer.byteLength(mockRedirectResponse.end.mock.calls[0][0] as string),
        );

        // device icons: served by the first instance having the file
        mockHTTPOnRequest({url: "/device_icons/my_device.png?v=1"}, 3);
        expect(mockNodeStatic[path.join(instanceA.dataPath, "device_icons")]).not.toHaveBeenCalled();
        expect(mockNodeStatic[path.join(instanceB.dataPath, "device_icons")]).toHaveBeenCalledWith({url: "/my_device.png?v=1"}, 3);

        mockHTTPOnRequest({url: "/device_icons/missing.png"}, 4);
        expect(mockSendNotFound).toHaveBeenCalledWith({url: "/missing.png"}, 4);

        // no path traversal
        mockSendNotFound.mockClear();
        mockHTTPOnRequest({url: "/device_icons/%2e%2e/configuration.yaml"}, 5);
        expect(mockSendNotFound).toHaveBeenCalledWith({url: "/%2e%2e/configuration.yaml"}, 5);
        mockHTTPOnRequest({url: "/device_icons/%2F"}, 6);
        expect(mockSendNotFound).toHaveBeenCalledWith({url: "/%2F"}, 6);
        expect(mockNodeStatic[path.join(instanceB.dataPath, "device_icons")]).toHaveBeenCalledTimes(1);
    });

    it("works with a non-default base url", async () => {
        hub = new FrontendHub({port: 8099, host: "127.0.0.1", base_url: "/z2m/"}, instances, logger);
        await hub.start();

        expect(mockHTTP.listen).toHaveBeenCalledWith(8099, "127.0.0.1");

        // outside of the base url
        mockHTTPOnRequest({url: "/other/file.txt"}, 1);
        expect(mockSendNotFound).toHaveBeenCalledWith({url: "/other/file.txt"}, 1);

        // the base url without trailing slash points at a directory, redirect so relative asset paths resolve against it
        mockHTTPOnRequest({url: "/z2m"}, mockRedirectResponse);
        expect(mockRedirectResponse.writeHead).toHaveBeenCalledWith(301, {Location: "/z2m/"});
        expect(mockRedirectResponse.end).toHaveBeenCalledTimes(1);

        mockHTTPOnRequest({url: "/z2m/"}, 2);
        expect(mockNodeStatic[frontendPath]).toHaveBeenCalledWith({url: "/"}, 2);

        // websocket path includes the base url
        expect(upgrade("/api")).toBeUndefined();
        expect(upgrade("/z2m/alpha/api")).toBeDefined();
    });

    it("listens on a unix socket and supports SSL", async () => {
        hub = new FrontendHub({host: "/tmp/hub.sock"}, instances, logger);
        await hub.start();
        expect(mockHTTP.listen).toHaveBeenCalledWith("/tmp/hub.sock");
        expect(logger.info).toHaveBeenCalledWith("Started combined frontend on socket /tmp/hub.sock");
        await hub.stop();
        expect(mockHTTP.close).toHaveBeenCalledTimes(1);
        expect(mockWS.close).toHaveBeenCalledTimes(1);

        const certs = path.join(__dirname, "assets", "certs");

        hub = new FrontendHub({ssl_key: path.join(certs, "dummy.key"), ssl_cert: path.join(certs, "dummy.crt")}, instances, logger);
        await hub.start();
        expect(mockHTTPS.listen).toHaveBeenCalledWith(8080);
        await hub.stop();
        expect(mockHTTPS.close).toHaveBeenCalledTimes(1);

        hub = new FrontendHub({ssl_key: "missing.key", ssl_cert: path.join(certs, "dummy.crt")}, instances, logger);
        await hub.start();
        expect(logger.error).toHaveBeenCalledWith("Defined ssl_key 'missing.key' file path does not exists, server won't be secured.");
        expect(mockHTTPS.listen).toHaveBeenCalledTimes(1);
        expect(mockHTTP.listen).toHaveBeenCalledTimes(2);
    });

    it("refuses to start with a frontend package without runtime configuration", async () => {
        fs.rmSync(path.join(frontendPath, "assets"), {recursive: true, force: true});
        hub = new FrontendHub({}, instances, logger);

        await expect(hub.start()).rejects.toThrow(
            `Frontend package at '${frontendPath}' has no runtime configuration module, combined frontend requires 'zigbee2mqtt-windfront'`,
        );

        fs.mkdirSync(path.join(frontendPath, "assets"));
        await expect(hub.start()).rejects.toThrow("has no runtime configuration module");
    });

    it("bridges browsers to the instances", async () => {
        hub = new FrontendHub({}, instances, logger);
        await hub.start();

        // unknown instance / invalid path
        expect(upgrade("/gamma/api")).toBeUndefined();
        expect(upgrade("/alpha/api/more")).toBeUndefined();

        // instance not attached yet
        const early = upgrade("/alpha/api");
        expect(early?.close).toHaveBeenCalledWith(1012, "Instance not running");

        hub.attach("alpha", channel.port1);

        const browser1 = upgrade("/alpha/api") as MockWebSocket;
        const browser2 = upgrade("/alpha/api") as MockWebSocket;
        await flush(2);
        expect(instanceMessages).toStrictEqual([
            {type: "open", id: 1},
            {type: "open", id: 2},
        ]);

        // browser -> instance (binary ignored)
        browser1.events.message(Buffer.from('{"topic":"bulb/set","payload":{"state":"ON"}}'), false);
        browser1.events.message(Buffer.from("binary"), true);
        await flush(3);
        expect(instanceMessages).toHaveLength(3);
        expect(instanceMessages[2]).toStrictEqual({type: "message", id: 1, data: '{"topic":"bulb/set","payload":{"state":"ON"}}'});

        // instance -> browsers
        channel.port2.postMessage({type: "send", id: 1, data: "for-browser1"});
        channel.port2.postMessage({type: "send", id: 99, data: "for-nobody"});
        channel.port2.postMessage({type: "broadcast", data: "for-all"});
        await vi.waitFor(() => expect(browser2.send).toHaveBeenCalled());
        expect(browser1.send.mock.calls).toStrictEqual([["for-browser1"], ["for-all"]]);
        expect(browser2.send.mock.calls).toStrictEqual([["for-all"]]);

        // closed browsers don't receive anything and are reported to the instance
        browser2.readyState = "closed";
        channel.port2.postMessage({type: "broadcast", data: "for-open-only"});
        await vi.waitFor(() => expect(browser1.send).toHaveBeenCalledTimes(3));
        expect(browser2.send).toHaveBeenCalledTimes(1);
        browser2.events.close();
        await flush(4);
        expect(instanceMessages).toHaveLength(4);
        expect(instanceMessages[3]).toStrictEqual({type: "close", id: 2});

        browser1.events.error(new Error("boom"));
        expect(logger.error).toHaveBeenCalledWith("WebSocket error (alpha): boom");

        // instance stopping: last message is delivered, browsers are closed without reporting back
        channel.port2.postMessage({type: "closeAll", data: "offline"});
        await vi.waitFor(() => expect(browser1.close).toHaveBeenCalledWith(1012, "Instance stopping"));
        expect(browser1.send).toHaveBeenLastCalledWith("offline");
        await flush();
        expect(instanceMessages).toHaveLength(4);

        // re-attach (instance restarted) closes browsers connected in-between
        const browser3 = upgrade("/alpha/api") as MockWebSocket;
        await flush(5);
        expect(instanceMessages[4]).toStrictEqual({type: "open", id: 3});
        const restarted = new MessageChannel();
        hub.attach("alpha", restarted.port1);
        expect(browser3.close).toHaveBeenCalledWith(1012, "Instance not running");
        await flush();
        expect(instanceMessages).toHaveLength(5); // the close of browser3 is not reported to the detached instance
        restarted.port2.close();

        hub.detach("alpha");
        hub.detach("alpha"); // no-op
    });

    it("authenticates browsers", async () => {
        hub = new FrontendHub({auth_token: "s3cret"}, instances, logger);
        await hub.start();
        hub.attach("beta", channel.port1);

        const unauthorized = upgrade("/beta/api") as MockWebSocket;
        expect(unauthorized.close).toHaveBeenCalledWith(4401, "Unauthorized");

        const wrong = upgrade("/beta/api?token=wrong") as MockWebSocket;
        expect(wrong.close).toHaveBeenCalledWith(4401, "Unauthorized");

        const authorized = upgrade("/beta/api?token=s3cret") as MockWebSocket;
        expect(authorized.close).not.toHaveBeenCalled();
        await flush(1);
        expect(instanceMessages).toStrictEqual([{type: "open", id: 1}]);

        // stopping the hub closes the browsers
        await hub.stop();
        expect(authorized.close).toHaveBeenCalledWith(1012, "Instance not running");
    });

    it("ignores attach/detach of unknown instances", () => {
        const port: MessagePort = channel.port1;
        vi.mocked(ws.Server).mockClear();
        hub = new FrontendHub({}, [], logger);
        hub.attach("alpha", port);
        hub.detach("alpha");
        // never started, nothing to clean up
        expect(ws.Server).not.toHaveBeenCalled();
    });
});
