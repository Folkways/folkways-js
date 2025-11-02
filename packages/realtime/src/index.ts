import { writeSync } from "fs";

interface ClientProps {
    token: string;
    segment: string;
}

export function Client(props: ClientProps) {
    const start = Date.now();
    const encoder = new TextEncoder();
    const tokenBytes = encoder.encode(props.token);
    const payload = new Uint8Array(2 + tokenBytes.length);
    payload[0] = 0x01; // AUTH type
    payload[1] = tokenBytes.length;
    payload.set(tokenBytes, 2);
    const end = Date.now();
    console.log("Client initialized with token:", props.token, "and segment:", props.segment, payload, "Initialization took", end - start, "ms");
}
