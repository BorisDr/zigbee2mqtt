import type { MessagePort } from "node:worker_threads";
/**
 * Describes the coordinator instance the current thread is running when Zigbee2MQTT is started in multi-coordinator
 * mode (one `worker_threads` Worker per coordinator, orchestrated by the supervisor). `undefined` in single-coordinator mode.
 */
export interface InstanceContext {
    /** Instance name, used as URL path segment in the combined frontend and as log prefix. */
    name: string;
    /** Zero-based index of the instance, matches the source index used by the frontend (`#/device/<index>/...`). */
    index: number;
    /** Channel to the combined frontend served by the supervisor. */
    frontendPort?: MessagePort;
    /** Public URL of the combined frontend, used for Home Assistant `configuration_url`. */
    frontendUrl?: string;
}
/** Messages sent from the combined frontend (supervisor) to an instance. */
export type HubToInstanceMessage = {
    type: "open";
    id: number;
} | {
    type: "message";
    id: number;
    data: string;
} | {
    type: "close";
    id: number;
};
/** Messages sent from an instance to the combined frontend (supervisor). */
export type InstanceToHubMessage = {
    type: "send";
    id: number;
    data: string;
} | {
    type: "broadcast";
    data: string;
} | {
    type: "closeAll";
    data: string;
};
export declare function setInstanceContext(newContext: InstanceContext | undefined): void;
export declare function getInstanceContext(): InstanceContext | undefined;
//# sourceMappingURL=instanceContext.d.ts.map