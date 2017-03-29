const ClientProxy = require('./proxy.js');
let proxy = new ClientProxy((req, res) => {
        // http intercepter
        console.log('http connection to host:', req.headers.host);

    }, (req, res) => {
        // https intercepter
        console.log('https connection to host:', req.headers.host);

    }, { // CAkeyOptions
        key: '_proxy-cert/proxy.key',
        keySize: 2048,
        cert: '_proxy-cert/proxy.crt'
    }, { // hostKeyOptions - options for server key generation
        keySize: 2048,
        reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
    },
    true // quietNetErrors
).start(0);

proxy.on('listening', () => {
    console.log ('proxy server started at port:', proxy.webProxyPort);
});

proxy.once('listening', () => {
    proxy.stop().start(9000);
});
