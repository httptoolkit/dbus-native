import * as stream from 'stream';

export function createClient(options: {
    stream?: stream.Duplex,
    direct?: boolean,
    authMethods?: string[]
}): DBusClient;

export interface DBusClient {
    getService(name: string): DBusService;
}

export interface DBusService {
    getInterface<
        T // Should be specified to define the methods available in the specific D-Bus interface
    >(path: string, name: string): Promise<DBusInterface & T>;
}

export interface DBusInterface {
    $name: string;
    $methods: { [name: string]: string }; // Name -> D-Bus type definition
}