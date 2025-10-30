import { writeSync } from "fs";

interface ClientProps {
    token: string;
    segment: string;
}

export function Client(props: ClientProps) {
    console.log("Client initialized with token:", props.token, "and segment:", props.segment);
}
