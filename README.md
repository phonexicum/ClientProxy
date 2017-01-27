# ClientProxy

This is nodejs based client-side proxy for http, https and *probably* web-sockets.

It is based on nodejs library [http-proxy](https://www.npmjs.com/package/http-proxy) (it is server side proxy server).

## Table of Contents

1. [Usage](#usage)
1. [Traffic path](#traffic-path)
1. [Drawbacks](#drawbacks)

## Usage

### Standalone usage

```
nodejs proxy.js 9000
```

By default CA key and certificate are searched in files *'proxy-cert/proxy.key'* and *'proxy-cert/proxy.crt'*.

### Usage as node module

``` JavaScript
const ClientProxy = require('proxy.js');
let proxy = new ClientProxy((req, res) => {
        // http intercepter
        console.log('http connection to host:', req.headers.host);

    }, (req, res) => {
        // https intercepter
        console.log('https connection to host:', req.headers.host);

    }, { // CAkeyOptions
        key: 'proxy-cert/proxy.key',
        keySize: 2048,
        cert: 'proxy-cert/proxy.crt'
    }, { // hostKeyOptions - options for server key generation
        keySize: 2048,
        reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
    }
);
proxy.run(9000);
// Do smth
proxy.stop();
// Do smth
proxy.run(9001);
proxy.stop();
```

## Traffic path

* browser makes HTTP request through proxy server **->** ClientProxy **->** http-proxy lib **->** server

* browser makes HTTPS request through proxy server:
    browser makes http request (CONNECT method) **->** ClientProxy http server gets requested hostName from headers
    1. ClientProxy ***answers*** `200 Connection established`
    1. ClientProxy ***generate certificate for requested host*** (using given CA certificate, or CA cert will be generated automatically)
        (remember, browser can deny unknown CA certificate unless security is disabled or exclusion added)
    1. ClientProxy ***starts https server*** with generated host certificate and passes ssl encrypted traffic (http CONNECT request body) to https server.
    https server gets traffic and unencrypts it **->** http-proxy lib **->** https server

* browser uses WebSockets **->** ClientProxy **->** http-proxy lib **->** server

## Drawbacks

1. Creation of custom https server per each https connection and sending traffic through it. 2 slowdowns:
    
    1. creation of custom https server
    2. using network stack to resend traffic to https server on local machine

    Why?: To easily use sequence ***https server **->** http-proxy lib **->** server***

1. For ssl keys and certificate generation third-party binary **openssl** is used, it is executed using child_process.execFileSync.

1. I never tested correctness of proxying WebSockets
