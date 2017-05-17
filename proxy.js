'use strict';

const debug = false;


// ====================================================================================================================
// Includes

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const Events = require('events');
const url = require('url');

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
function setObjFuncWatch(res, func, event_name){
    let original = res[func];

    res[func] = function() {
        res.emit(event_name);
        original.apply(res, arguments);
    };
};


// ====================================================================================================================
class ClientProxy extends Events {

    // ================================================================================================================
    constructor(httpReqInterceptor, httpsReqInterceptor, httpResInterceptor, httpsResInterceptor, CAkeyOptions = {
            key: 'proxy-cert/proxy.key',
            keySize: 2048,
            cert: 'proxy-cert/proxy.crt'
        }, hostKeyOptions = { // Options for key to be generated as server key
            keySize: 2048,
            reuseCAkey: true // flag indicating if proxy can reuse CA private key as server key
        },
        checkServerCerts = true,
        quietNetErrors = true) {

        super();

        this.httpReqInterceptor = httpReqInterceptor;
        this.httpResInterceptor = httpResInterceptor;
        this.httpsReqInterceptor = httpsReqInterceptor;
        this.httpsResInterceptor = httpsResInterceptor;
        this._CAkeyOptions = CAkeyOptions;
        this._hostKeyOptions = hostKeyOptions;
        this._checkServerCerts = checkServerCerts;
        this._quietNetErrors = quietNetErrors;
        this.webProxyPort = 0;

        this._checkCAcertificate();

        this._proxyServer = httpProxy.createProxyServer({});

        this._sslOptionsStorage = new SSLOptions(this._CAkeyOptions, this._hostKeyOptions);
        this._createWebProxy();
    }

    // ================================================================================================================
    _checkCAcertificate () {
        if (!fs.existsSync(this._CAkeyOptions.key) || !fs.existsSync(this._CAkeyOptions.cert)) {

            if (debug) console.log('CAkey and CAcert will be generated.');

            childProcess.execFileSync('mkdir', ['-p', path.parse(this._CAkeyOptions.key).dir]);
            childProcess.execFileSync('mkdir', ['-p', path.parse(this._CAkeyOptions.cert).dir]);
            
            // Create proxy root certificate authority (key)
            childProcess.execFileSync('openssl', [ 'genrsa',
                '-out', this._CAkeyOptions.key,
                this._CAkeyOptions.keySize + ''
            ], {stdio: 'inherit'});

            // Create self-signed certificate for root authority - create CA
            childProcess.execFileSync('openssl', ['req', '-x509',
                '-new',
                '-nodes',
                '-days', '365000',
                '-key', this._CAkeyOptions.key,
                '-subj', '/C=RU/ST=Russia/L=Moscow/O=ClientProxy/OU=proxy/CN=localhost.com/emailAddress=localhost@localhost.com',
                '-out', this._CAkeyOptions.cert
            ], {stdio: 'inherit'});
        } else {
            if (debug) console.log('CA key and CA certificate exists.');
        }
    }
    
    // ================================================================================================================
    _createWebProxy () {
        
        // This is necessary or proxyServer can throw exception and proxy process will die
        this._proxyServer.on('error', error => {
            console.log('Error:', error);
        });
        this._proxyServer.on('error', error => {
            console.log('Error:', error);
        });

        this._webProxy = http.createServer((req, res) => {
            let ret = this.httpReqInterceptor(req, res);
            
            res.once('headersEnded', () => {
                this.httpResInterceptor(req, res);
            });
            setObjFuncWatch(res, 'writeHead', 'headersEnded');
            setObjFuncWatch(res, 'write', 'headersEnded');
            setObjFuncWatch(res, 'end', 'headersEnded');

            if (ret !== false)
                this._proxyServer.web(req, res, {target: 'http://' + req.headers.host});
            else if (res.finished === false)
                res.end();
        });

        this._webProxy.addListener('connect', (req, ctlSocket, head) => {
            
            if (debug) console.log ('http "CONNECT" method.');
            if (debug) console.log ('CONNECT req.headers: ', req.headers);
            // if (debug) console.log ('CONNECT head.length: ', head.length);

            let parseHostName = /(.*):(\d*)/i.exec(req.headers.host);
            let hostName = parseHostName !== null && parseHostName[2] === '443' ? parseHostName[1] : parseHostName[0];
            const httpsOptions = this._sslOptionsStorage.getOption(hostName);
            
            let httpsProxy = https.createServer(httpsOptions, (request, response) => {
                
                let ret = this.httpsReqInterceptor(request, response);

                response.once('headersEnded', () => {
                    this.httpsResInterceptor(request, response);
                });
                setObjFuncWatch(response, 'writeHead', 'headersEnded');
                setObjFuncWatch(response, 'write', 'headersEnded');
                setObjFuncWatch(response, 'end', 'headersEnded');
                
                if (ret !== false)
                    this._proxyServer.web(request, response, {
                        target: 'https://' + request.headers.host,
                        ssl: httpsOptions,
                        secure: this._checkServerCerts
                    });
                else if (response.finished === false)
                    response.end();

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
                    if (! this._quietNetErrors)
                        console.error('Error from http "CONNECT" socket, host: ', req.headers.host, 'Error: ', error);
                    // socketToHttpsProxy.end();
                });

                socketToHttpsProxy.on('error', (error) => {
                    if (! this._quietNetErrors)
                        console.error('Error from https socket, host: ', req.headers.host, 'Error: ', error);
                    // ctlSocket.end();
                });
            });
        });

        this._webProxy.on('listening', () => {
            this.webProxyPort = this._webProxy.address().port;
            this.emit('listening');
        });

        // proxy websockets
        // MARK: Never tested websockets
        this._webProxy.on('upgrade', (req, socket, head) => {
            this.httpProxyServer.ws(req, socket, head);
        });

        // easy websockets proxy
        // let ws_server = http.createServer((req, res) => {
        //     this.httpProxyServer.web(req, res, { target: 'ws://' + req.headers.host, ws: true });
        // });
        // ws_server.on('upgrade', (req, socket, head) => {
        //     this.httpProxyServer.ws(req, socket, head);
        // });
        // ws_server.listen(webProxyPort);
    }

    // ================================================================================================================
    start(portNumber){
        this._webProxy.listen(portNumber);
        return this;
    }

    // ================================================================================================================
    stop(){
        this._webProxy.close();
        return this;
    }

    // ================================================================================================================
}

// ====================================================================================================================
if (!module.parent) {
    const webProxyPort = process.argv.length === 3 ? parseInt(process.argv[2]) : 0;

    let clientProxy = new ClientProxy((req, res) => {
            // http request intercepter
            console.log('connection url:', req.url);

        }, (req, res) => {
            // https request intercepter
            
            let reqUrl = url.parse(req.url);
            reqUrl.protocol = 'https:';
            reqUrl.host = req.headers.host;
            reqUrl = url.parse(url.format(reqUrl));

            console.log('connection url:', reqUrl.href);

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
        false, // checkServerCerts
        false // quietNetErrors
    );

    clientProxy.start(webProxyPort);
    clientProxy.on('listening', () => {
        console.log ('Proxy started on port:', clientProxy.webProxyPort);
    });
}

module.exports = ClientProxy;
