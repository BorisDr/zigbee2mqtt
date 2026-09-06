import Extension from "./extension";
/**
 * This extension servers the frontend.
 *
 * In multi-coordinator mode the UI is served by the supervisor (combined frontend for all coordinators), and this
 * extension only bridges the browser connections handed over through a `MessagePort` to the MQTT layer of this instance.
 */
export declare class Frontend extends Extension {
    private mqttBaseTopic;
    private server;
    private wss;
    private baseUrl;
    /** Channel to the combined frontend, only set in multi-coordinator mode. */
    private hubPort;
    /** Browser connections currently open through the combined frontend. */
    private hubClients;
    constructor(zigbee: Zigbee, mqtt: Mqtt, state: State, publishEntityState: PublishEntityState, eventBus: EventBus, enableDisableExtension: (enable: boolean, name: string) => Promise<void>, restartCallback: () => Promise<void>, addExtension: (extension: Extension) => Promise<void>);
    start(): Promise<void>;
    stop(): Promise<void>;
    private postToHub;
    private onHubMessage;
    /** Message received from a browser: `{topic, payload}` relative to the base topic, injected as MQTT message. */
    private onClientMessage;
    /** Sends retained messages and the current state of all devices to a newly connected browser. */
    private sendInitialState;
    private onUpgrade;
    private onWebSocketConnection;
    private onMQTTPublishMessageOrEntityState;
}
export default Frontend;
//# sourceMappingURL=frontend.d.ts.map