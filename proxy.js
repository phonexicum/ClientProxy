'use strict';

const debug = false;


// ====================================================================================================================
// Includes

const fs = require('fs');
const childProcess = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');

const tmp = require('tmp');
const httpProxy = require('http-proxy');


// ====================================================================================================================
class SSLOptions {

    // ================================================================================================================
    constructor(CAkeyOptions = {
            key: 'proxy-cert/proxy.key',
            cert: 'proxy-cert/proxy.crt'
        }, hostKeyOptions = { // Options for key to be generated as server key
            keySize: 2048,
            reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
        }) {

        this.CAkeyOptions = CAkeyOptions;
        this.hostKeyOptions = hostKeyOptions;
        this._hostsSSLOptions = {};
    }

    // ================================================================================================================
    getOption (host) {
        if (host in this._hostsSSLOptions)
            return this._hostsSSLOptions[host];

        if (debug) console.log('Generating new certificate for host: "' + host + '"');

        let tmpDir = tmp.dirSync();
        if (debug) console.log('tmpDir: ', tmpDir.name);

        let serverKeyPath = this.hostKeyOptions.reuseCAkey ? this.CAkeyOptions.key : tmpDir.name + '/server.key';

        if (this.hostKeyOptions.reuseCAkey === false) {
            // Create server certificate authority (key)
            childProcess.execFileSync('openssl', [ 'genrsa',
                '-out', serverKeyPath,
                this.hostKeyOptions.keySize + ''
            ]);
        }

        // Create a request from server, which will be signed by root authority
        childProcess.execFileSync('openssl', ['req',
            '-new',
            '-key', serverKeyPath,
            '-out', tmpDir.name + '/server.csr',
            '-subj', '/C=RU/ST=Russia/L=Moscow/O=ClientProxy/OU=proxy/CN=localhost.com/emailAddress=' + host
        ], debug ? {stdio: 'inherit'} : {stdio: 'pipe'});

        // Sign the server request with root CA
        childProcess.execFileSync('openssl', ['x509', '-req',
            '-days', '365000',
            '-in', tmpDir.name + '/server.csr',
            '-CA', this.CAkeyOptions.cert,
            '-CAkey', serverKeyPath,
            '-CAcreateserial',
            '-out', tmpDir.name + '/server.crt'
        ], debug ? {stdio: 'inherit'} : {stdio: 'pipe'});

        this._hostsSSLOptions[host] = {
            key: fs.readFileSync(serverKeyPath, 'utf8'),
            cert: fs.readFileSync(tmpDir.name + '/server.crt', 'utf8')
        };

        if (debug) console.log('Certificate for host: "' + host + '" successfully generated.');
        childProcess.execFileSync('rm', ['-R', tmpDir.name + '/'], debug ? {stdio: 'inherit'} : {stdio: 'pipe'});
        // tmpDir.removeCallback();
        return this._hostsSSLOptions[host];
    }

    // ================================================================================================================
}


// ====================================================================================================================
class ClientProxy {

    // ================================================================================================================
    constructor(httpInterceptor, httpsInterceptor, CAkeyOptions = {
            key: 'proxy-cert/proxy.key',
            keySize: 2048,
            cert: 'proxy-cert/proxy.crt'
        }, hostKeyOptions = { // Options for key to be generated as server key
            keySize: 2048,
            reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
        }) {

        this.httpInterceptor = httpInterceptor;
        this.httpsInterceptor = httpsInterceptor;
        this.CAkeyOptions = CAkeyOptions;
        this.hostKeyOptions = hostKeyOptions;

        this.checkCAcertificate();

        this.proxyServer = httpProxy.createProxyServer({});
        this.sslOptionsStorage = new SSLOptions(this.CAkeyOptions, this.hostKeyOptions);
        this.createWebProxy();
    }

    // ================================================================================================================
    checkCAcertificate () {
        if (!fs.existsSync(this.CAkeyOptions.key) || !fs.existsSync(this.CAkeyOptions.cert)) {

            if (debug) console.log('CAkey and CAcert will be generated.');

            childProcess.execFileSync('mkdir', ['-p', keyDir]);
            
            // Create proxy root certificate authority (key)
            childProcess.execFileSync('openssl', [ 'genrsa',
                '-out', this.CAkeyOptions.key,
                this.CAkeyOptions.keySize + ''
            ], {stdio: 'inherit'});

            // Create self-signed certificate for root authority - create CA
            childProcess.execFileSync('openssl', ['req', '-x509',
                '-new',
                '-nodes',
                '-days', '365000',
                '-key', this.CAkeyOptions.key,
                '-subj', '/C=RU/ST=Russia/L=Moscow/O=ClientProxy/OU=proxy/CN=localhost.com/emailAddress=localhost@localhost.com',
                '-out', this.CAkeyOptions.cert
            ], {stdio: 'inherit'});
        } else {
            if (debug) console.log('CA key and CA certificate exists.');
        }
    }
    
    // ================================================================================================================
    createWebProxy () {
        
        this.webProxy = http.createServer((req, res) => {
            this.httpInterceptor (req, res);
            this.proxyServer.web(req, res, {target: 'http://' + req.headers.host});
        });

        this.webProxy.addListener('connect', (req, ctlSocket, head) => {
            
            if (debug) console.log ('http "CONNECT" method.');
            if (debug) console.log ('CONNECT req.headers: ', req.headers);
            // if (debug) console.log ('CONNECT head.length: ', head.length);

            const httpsOptions = this.sslOptionsStorage.getOption(req.headers.host);
            let httpsProxy = https.createServer(httpsOptions, (request, response) => {
                
                this.httpsInterceptor (request, response);
                
                proxyServer.web(request, response, {
                    target: 'https://' + req.headers.host,
                    ssl: httpsOptions,
                    secure: false // I don't want to verify the ssl certs
                });
            }).listen(0);
            if (debug) console.log ('https proxy initialized.');
            
            let socketToHttpsProxy = new net.Socket();

            httpsProxy.once('listening', () => {
                const sslProxyPort = httpsProxy.address().port;
                if (debug) console.log ('https proxy port: ', sslProxyPort);

                socketToHttpsProxy.connect(sslProxyPort, '127.0.0.1', () => {
                    socketToHttpsProxy.write(head);
                    ctlSocket.write('HTTP/' + req.httpVersion + ' 200 Connection established \r\n\r\n');
                });

                ctlSocket.on('data', (dataChunk) => {
                    if (debug) console.log('Request data chunk: ', dataChunk);
                    socketToHttpsProxy.write(dataChunk);
                });

                ctlSocket.on('end', () => {
                    if (debug) console.log('http "CONNECT" socket closed, closing https socket, shutdown individual https proxy.');
                    socketToHttpsProxy.end();
                    httpsProxy.close();
                });

                socketToHttpsProxy.on('data', (dataChunk) => {
                    if (debug) console.log('Response data chunk: ', dataChunk);
                    ctlSocket.write(dataChunk);
                });

                socketToHttpsProxy.on('end', () => {
                    if (debug) console.log('https socket closed, closing http "CONNECT" socket.');
                    ctlSocket.end();
                });

                ctlSocket.on('error', (error) => {
                    console.error('Error from http "CONNECT" socket, host: ', req.headers.host);
                    socketToHttpsProxy.end();
                });

                socketToHttpsProxy.on('error', (error) => {
                    console.error('Error from https socket, host: ', req.headers.host);
                    ctlSocket.end();
                });
            });
        });

        // proxy websockets
        this.webProxy.on('upgrade', (req, socket, head) => {
            proxyServer.ws(req, socket, head);
        });

        // easy websockets proxy
        // let ws_server = http.createServer((req, res) => {
        //     proxyServer.web(req, res, { target: 'ws://' + req.headers.host, ws: true });
        // });
        // ws_server.on('upgrade', (req, socket, head) => {
        //     proxyServer.ws(req, socket, head);
        // });
        // ws_server.listen(webProxyPort);
    }


    // ================================================================================================================
    run(webProxyPort){
        this.webProxy.listen(webProxyPort);
    }

    // ================================================================================================================
    stop(){
        this.webProxy.close();
    }

    // ================================================================================================================
}
module.exports = ClientProxy;

if (!module.parent) {
    const webProxyPort = process.argv.length === 3 ? parseInt(process.argv[2]) : 9000;
    console.log('webProxyPort: ', webProxyPort);

    let clientProxy = ClientProxy((req, res) => {
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

    clientProxy.run(webProxyPort);
}
