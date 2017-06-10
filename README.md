# ClientProxy

This is NodeJS based client-side proxy for http/https and *probably* web-sockets.

It is based on nodejs library [http-proxy](https://www.npmjs.com/package/http-proxy) (it is server side proxy server).

Thanks to *newspaint* for the article [Node.JS HTTP and HTTPS Proxy](https://newspaint.wordpress.com/2012/11/05/node-js-http-and-https-proxy/) where he shows an example of creating http-proxy.

## Table of Contents

1. [Usage example](#usage)
1. [Traffic path](#traffic-path)
1. [Drawbacks](#drawbacks)
1. [API](#api)

## Usage example

### Standalone usage

```
node proxy.js 9000
```

By default CA key and certificate are searched in files *'proxy-cert/proxy.key'* and *'proxy-cert/proxy.crt'*.

### Usage as node module

``` JavaScript
const ClientProxy = require('./proxy.js');
let proxy = new ClientProxy((req, res) => {
        // http intercepter
        console.log('http connection to host:', req.headers.host);

    }, (req, res) => {
        // https intercepter
        console.log('https connection to host:', req.headers.host);

    }, (req, res) => {
        // http response intercepter
        res.removeHeader('Date');

    }, (req, res) => {
        // https response intercepter
        res.removeHeader('Date');

    }, { // CAkeyOptions
        key: 'proxy-cert/proxy.key',
        keySize: 2048,
        cert: 'proxy-cert/proxy.crt'
    }, { // hostKeyOptions - options for server key generation
        keySize: 2048,
        reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
    },
    false, // check server certificate
    true // quietNetErrors
).start(0);

proxy.on('listening', () => {
    console.log ('proxy server started at port:', proxy.webProxyPort);
});

proxy.once('listening', () => {
    proxy.stop().start(9000);
});
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

    Why?: To easily use sequence ***https server -> http-proxy lib -> server***

1. For ssl keys and certificate generation third-party binary **openssl** is used, it is executed using child_process.execFileSync.

1. I never tested correctness of proxying WebSockets

## API

Module provide `ClientProxy` class.

* Functions:

    `new ClientProxy(...);` - look example in [usage example](#usage-as-node-module), all constructor parameters are not required, their default values can be seen in usage example.

    `ClientProxy.start(portNumber)` - starts web proxy on specified port number (if port equals to 0, OS will choose random port).

    `ClientProxy.stop()` - stops web proxy (proxy can be started again on other port number)
    
    Methods `start` and `stop` can be chained.

* Interceptors:

    `ClientProxy.httpReqInterceptor (req, res);` - if return value === false, there will be no further proxying, you will have to process request on your own.

    `ClientProxy.httpsReqInterceptor (req, res);` - if return value === false, there will be no further proxying, you will have to process request on your own.

    request intercepters are called after webProxy finished sending headers to browser and ready to send data or close connection

    you ***can not*** modify request, you ***can not*** use res.end or res.write or res.writeHead, you ***can*** influence header

    `ClientProxy.httpResInterceptor (req, res);`

    `ClientProxy.httpsResInterceptor (req, res);`

* Variables:

    `ClientProxy.webProxyPort` - equals to `0`, until 'listening' event fired

* Events:

    `'listening'`: emits after ClientProxy http server started and ready to work.

    `clientProxy.webProxyPort` will show correct port number of proxy server after this event (in case you specified port number = `0` while starting proxy).

* Internals:

    `clientProxy._webProxy` - http server object used to listen requests to be proxied. ***Modify it at your own risk.***

    `clientProxy._proxyServer` - http-proxy lib proxy server instance, used to forward requests further. ***Modify it at your own risk.***
