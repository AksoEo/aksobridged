const { Server } = require('net');
const { workerData, parentPort } = require('worker_threads');
const { AppClient, UserClient } = require('@tejo/akso-client');
const { evaluate, currencies } = require('@tejo/akso-script');
const { CookieJar } = require('tough-cookie');
const { encode, decode } = require('@msgpack/msgpack');
const { setThreadName, info, debug, error } = require('./log');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs');
const crypto = require('crypto');
const { Cashify } = require('cashify');

process.on('uncaughtException', err => {
    error(`!!!! uncaught exception`);
    console.error(err);
});

setThreadName(`W${workerData.id}`);
parentPort.on('message', message => {
    if (!message) return;
    if (message.type === 'init') {
        init(message.channel);
    }
});

// The disk cache uses file names as an index for easy retrieval.
// File names are the following base64(msgpack)-encoded objects:
//
// ```json
// [apiHost, method, path, query]
// ```
//
// object keys in query must be alphanumerically sorted.
//
// The file contents will then hold the following msgpack-encoded data:
//
// ```json
// { maxAge: max age in seconds, data: (data object) }
// ```
//
// Temporary files are used for writing. They will always start with a $ character.
const cachePath = workerData.cachePath;

function alphaSortObject (value) {
    if (Array.isArray(value)) return value;
    else if (typeof value === 'object' && value !== null) {
        const keys = Object.keys(value).sort();
        const res = {};
        for (const k of keys) res[k] = value[k];
        return res;
    } else return value;
}
function getCacheKey (host, method, path, query) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(encode([host, method, path, alphaSortObject(query)])));
    return hash.digest('hex');
}

const fsStat = promisify(fs.stat);
const fsReadFile = promisify(fs.readFile);
const fsWriteFile = promisify(fs.writeFile);
const fsRename = promisify(fs.rename);

const cache = {
    get: async (host, method, resPath, query) => {
        const filePath = path.join(cachePath, getCacheKey(host, method, resPath, query));

        // first, figure out file age
        let stats;
        try {
            stats = await fsStat(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                // no cache file
                return null;
            } else throw err;
        }
        const age = (Date.now() - stats.mtimeMs) / 1000;

        // read the file
        const contents = await fsReadFile(filePath);
        const rootNode = decode(contents);

        // if the file is older than we want, we pretend we don’t have anything
        // cached
        if (age > rootNode.maxAge) return null;
        else return rootNode.data; // otherwise return the data
    },
    insert: async (host, method, resPath, query, maxCacheSecs, data) => {
        const filePath = path.join(cachePath, getCacheKey(host, method, resPath, query));

        const tmpWritePath = path.join(cachePath, '$' + Math.random().toString(36));

        const fileData = encode({
            maxAge: maxCacheSecs,
            data,
        });

        // write the data into a new tmp file
        await fsWriteFile(tmpWritePath, fileData);

        // rename the file to the target name
        await fsRename(tmpWritePath, filePath);
    },
};

function init (channel) {
    debug('initializing');

    channel.on('message', message => {
        if (message.type === 'close') {
            debug('closing server');
            server.close();
            info('server closed');
            setTimeout(() => {
                channel.close();
            }, 30);
        }
    });

    const server = new Server(conn => {
        new ClientHandler(conn);
    });

    const listenAddr = `${workerData.path}/ipc${workerData.id}`;
    server.listen(listenAddr, () => {
        info(`listening on ${listenAddr}`);
    });
}

const MAGIC = Buffer.from('abx1');
const MAX_SANE_MESSAGE_LEN = 10 * 1024 * 1024; // 10 MiB

const encodeMessage = msg => {
    const packed = Buffer.from(encode(msg));
    const buf = Buffer.allocUnsafe(packed.length + 4);
    buf.writeInt32LE(packed.length, 0);
    packed.copy(buf, 4);
    return buf;
};

class ClientHandler {
    constructor (connection) {
        this.connection = connection;
        this.connection.setTimeout(1000);
        this.connection.on('data', data => this.onData(data));
        this.connection.on('timeout', () => this.onTimeout());
        this.connection.on('close', () => this.onClose());

        this.didInit = false;
        this.currentMessageLen = null;
        this.currentMessageBuffer = null;
        this.currentMessageCursor = 0;
        this.didEnd = false;

        // -----
        this.apiHost = null;
        this.didHandshake = false;
        this.ip = null;
        this.cookies = null;
        this.client = null;
        this.waitTasks = 0;
    }

    flushMessage () {
        this.currentMessageLen = null;
        let decoded;
        try {
            decoded = decode(this.currentMessageBuffer);
            if (typeof decoded !== 'object') throw new Error('expected object as root');
            if (typeof decoded.t !== 'string') throw new Error('expected t: string');
            if (typeof decoded.i !== 'string') throw new Error('expected i: string');
        } catch (err) {
            this.close('TXERR', 402, `failed to decode input: ${err}`);
            return;
        }

        this.handleInput(decoded);
    }

    onData (data) {
        let cursor = 0;

        if (!this.didInit) {
            if (data.slice(0, MAGIC.length).equals(MAGIC)) {
                this.didInit = true;
                cursor += MAGIC.length;
            } else {
                this.close('TXERR', 400, 'bad magic');
                return;
            }
        }

        while (cursor < data.length) {
            if (this.currentMessageLen === null) {
                // awaiting message length
                this.currentMessageLen = data.readInt32LE(cursor);
                if (this.currentMessageLen < 0) {
                    this.close('TXERR', 401, 'message has negative length');
                    return;
                } else if (this.currentMessageLen > MAX_SANE_MESSAGE_LEN) {
                    this.close('TXERR', 401, 'message is too long');
                    return;
                }
                cursor += 4;
                this.currentMessageBuffer = Buffer.allocUnsafe(this.currentMessageLen);
                this.currentMessageCursor = 0;
            } else {
                // message contents
                const messageBytesLeft = this.currentMessageLen - this.currentMessageCursor;
                const inputBytesLeft = data.length - cursor;

                if (inputBytesLeft >= messageBytesLeft) {
                    // rest of message is entirely contained in data
                    data.copy(this.currentMessageBuffer, this.currentMessageCursor, cursor, cursor + messageBytesLeft);
                    this.flushMessage();
                    cursor += messageBytesLeft;
                } else {
                    // data contains a part of the message
                    data.copy(this.currentMessageBuffer, this.currentMessageCursor, cursor, cursor + inputBytesLeft);
                    this.currentMessageCursor += inputBytesLeft;
                    cursor += inputBytesLeft;
                }
            }
        }
    }

    send (data) {
        if (this.didEnd) return;
        this.connection.write(encodeMessage(data));
    }

    close (t, c, m) {
        if (this.didEnd) return;
        this.didEnd = true;
        this.connection.end(encodeMessage({ t, c, m }));
    }

    onClose () {
        this.flushSendCookies();
        this.didEnd = true;
    }

    onTimeout () {
        if (this.waitTasks > 0) {
            this.send({ t: '❤' });
        } else {
            this.close('TXERR', 103, 'timed out');
        }
    }

    // -----

    handleInput (message) {
        if (!this.didHandshake && message.t !== 'hi' && message.t !== 'hic') return;

        const handler = messageHandlers[message.t];
        if (!handler) {
            this.close('TXERR', 200, `unknown message type ${message.t}`);
            return;
        }

        this.waitTasks++;
        handler(this, message).then(response => {
            this.send({
                t: '~',
                i: message.i,
                ...response,
            });
        }).catch(err => {
            this.send({
                t: '~!',
                i: message.i,
                m: err.toString(),
            });
        }).then(() => {
            this.waitTasks--;
        });
    }

    debouncedSetCookie = null;
    cookieQueue = [];
    flushSendCookies () {
        clearTimeout(this.debouncedSetCookie);
        if (this.cookieQueue.length) {
            this.send({ t: 'co', co: this.cookieQueue });
            this.cookieQueue = [];
        }
    }

    recordSetCookie (cookie) {
        this.cookieQueue.push(cookie);
        if (!this.debouncedSetCookie) {
            this.debouncedSetCookie = setTimeout(() => this.flushSendCookies(), 1);
        }
    }
}

function assertType (v, t, n) {
    let chk = typeof v === t;
    if (t === 'array') chk = Array.isArray(v);
    if (!chk) {
        throw new Error(n);
    }
}

const messageHandlers = {
    hi: async (conn, { ip, co, api }) => {
        debug(`connection handshake from ip ${ip}`);
        assertType(api, 'string', 'expected api to be a string');
        assertType(ip, 'string', 'expected ip to be a string');
        assertType(co, 'object', 'expected co to be an object');
        if (conn.didHandshake) {
            throw new Error('double handshake');
        }

        const apiHost = api;

        conn.apiHost = apiHost;
        conn.cookies = {
            conn,
            jar: new CookieJar(),
            // fetch-cookie only uses these two methods
            getCookieString (...args) {
                return this.jar.getCookieString(...args);
            },
            setCookie (cookie, url, callback) {
                const { conn, jar } = this;
                conn.recordSetCookie(cookie); // FIXME: should url be checked?
                return jar.setCookie(cookie, url, callback);
            },
        };

        // initialize cookies
        for (const k in co) {
            const v = co[k];
            assertType(v, 'string', 'expected cookie value to be a string');
            conn.cookies.jar.setCookieSync(`${k}=${v}`, apiHost);
        }

        conn.client = new UserClient({
            host: apiHost,
            userAgent: workerData.userAgent,
            cookieJar: conn.cookies,
            headers: {
                'X-Forwarded-For': ip,
            },
        });

        conn.didHandshake = true;

        const sesx = await conn.client.restoreSession();
        if (sesx === false) return { auth: false };
        return {
            auth: true,
            uea: sesx.newCode,
            id: sesx.id,
            totp: sesx.totpSetUp && !sesx.totpUsed,
            member: sesx.isActiveMember,
        };
    },
    hic: async (conn, { api, key, sec }) => {
        debug(`api client handshake for ${key}`);
        assertType(api, 'string', 'expected api to be a string');
        assertType(key, 'string', 'expected key to be a string');
        assertType(sec, 'string', 'expected sec to be a string');
        if (conn.didHandshake) {
            throw new Error('double handshake');
        }

        const apiHost = api;
        conn.apiHost = apiHost;

        conn.client = new AppClient({
            host: apiHost,
            userAgent: workerData.userAgent,
            apiKey: key,
            apiSecret: sec,
        });


        conn.didHandshake = true;

        return {};
    },
    login: async (conn, { un, pw }) => {
        assertType(un, 'string', 'expected un to be a string');
        assertType(pw, 'string', 'expected pw to be a string');
        try {
            const sesx = await conn.client.logIn(un, pw);
            return {
                s: true,
                uea: sesx.newCode,
                id: sesx.id,
                totp: sesx.totpSetUp && !sesx.totpUsed,
                member: sesx.isActiveMember,
            };
        } catch (err) {
            if (err.statusCode === 400 || err.statusCode === 401) {
                return { s: false, nopw: false };
            } else if (err.statusCode === 409) {
                return { s: false, nopw: true };
            } else {
                throw err;
            }
        }
    },
    logout: async (conn) => {
        try {
            await conn.client.logOut();
            return { s: true };
        } catch (err) {
            if (err.statusCode === 404) {
                return { s: false };
            } else {
                throw err;
            }
        }
    },
    totp: async (conn, { co, se, r }) => {
        assertType(co, 'string', 'expected co to be a string');
        assertType(r, 'boolean', 'expected r to be a bool');
        try {
            if (se) {
                await conn.client.totpSetUp(se, co, r);
            } else {
                await conn.client.totpLogIn(co, r);
            }
            return { s: true };
        } catch (err) {
            if (err.statusCode === 400 || err.statusCode === 401) {
                return { s: false, bad: false, nosx: false };
            } else if (err.statusCode === 403) {
                return { s: false, bad: true, nosx: false };
            } else if (err.statusCode === 404) {
                return { s: false, bad: false, nosx: true };
            } else {
                throw err;
            }
        }
    },
    '-totp': async (conn) => {
        try {
            await conn.client.totpRemove();
            return { s: true };
        } catch (err) {
            if (err.statusCode === 401 || err.statusCode === 404) {
                return { s: false };
            } else {
                throw err;
            }
        }
    },
    get: async (conn, { p, q, c }) => {
        assertType(p, 'string', 'expected p to be a string');
        assertType(q, 'object', 'expected q to be an object');
        assertType(c, 'number', 'expected c to be a number');
        if (c < 0) throw new Error('negative cache time');

        if (c) {
            const cachedResponse = await cache.get(conn.apiHost, 'GET', p, q);
            if (cachedResponse !== null) return cachedResponse;
        }

        try {
            const res = await conn.client.get(p, q);
            const response = {
                k: res.ok,
                sc: res.res.status,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };

            if (c) await cache.insert(conn.apiHost, 'GET', p, q, c, response);

            return response;
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    delete: async (conn, { p, q }) => {
        assertType(p, 'string', 'expected p to be a string');
        assertType(q, 'object', 'expected q to be an object');

        try {
            const res = await conn.client.delete(p, q);
            return {
                k: res.ok,
                sc: res.res.status,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    post: async (conn, { p, b, q, f }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');
        assertType(f, 'object', 'expected f to be an object');

        const files = [];
        for (const n in f) {
            const file = f[n];
            assertType(file, 'object', 'expected file to be an object');
            assertType(file.t, 'string', 'expected file.t to be a string');
            files.push({
                name: n,
                type: file.t,
                value: file.b,
            });
        }

        try {
            const res = await conn.client.post(p, b, q, files);
            return {
                k: res.ok,
                sc: res.res.status,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    put: async (conn, { p, b, q, f }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');
        assertType(f, 'object', 'expected f to be an object');

        const files = [];
        for (const n in f) {
            const file = f[n];
            assertType(file, 'object', 'expected file to be an object');
            assertType(file.t, 'string', 'expected file.t to be a string');
            files.push({
                name: n,
                type: file.t,
                value: file.b,
            });
        }

        try {
            const res = await conn.client.put(p, b, q, files);
            return {
                k: res.ok,
                sc: res.res.status,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    patch: async (conn, { p, b, q }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');

        try {
            const res = await conn.client.patch(p, b, q);
            return {
                k: res.ok,
                sc: res.res.status,
                h: collectHeaders(res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    perms: async (conn, { p }) => {
        assertType(p, 'array', 'expected p to be an array');
        const res = [];
        for (const perm of p) {
            assertType(perm, 'string', 'expected permission to be a string');
            res.push(await conn.client.hasPerm(perm));
        }
        return { p: res };
    },
    permscf: async (conn, { f }) => {
        assertType(f, 'array', 'expected f to be an array');
        const res = [];
        for (const fieldFlags of f) {
            assertType(fieldFlags, 'string', 'expected field.flags to be a string');
            const parts = fieldFlags.split('.');
            const field = parts[0];
            const flags = parts[1];
            res.push(await conn.client.hasCodeholderField(field, flags));
        }
        return { f: res };
    },
    permsocf: async (conn, { f }) => {
        assertType(f, 'array', 'expected f to be an array');
        const res = [];
        for (const fieldFlags of f) {
            assertType(fieldFlags, 'string', 'expected field.flags to be a string');
            const parts = fieldFlags.split('.');
            const field = parts[0];
            const flags = parts[1];
            res.push(await conn.client.hasOwnCodeholderField(field, flags));
        }
        return { f: res };
    },
    regexp: async (conn, { r, s }) => {
        assertType(r, 'string', 'expected r to be a string');
        assertType(s, 'string', 'expected s to be a string');
        try {
            const re = new RegExp(r);
            return { m: !!re.test(s) };
        } catch (err) {
            return { m: false };
        }
    },
    asc: async (conn, { s, fv, e }) => {
        assertType(s, 'array', 'expected s to be an array');
        assertType(fv, 'object', 'expected fv to be an object');
        assertType(e, 'object', 'expected e to be an object');
        try {
            let iter = 0;
            const sym = Symbol('result');
            const res = evaluate(s.concat({
                [sym]: e,
            }), sym, id => fv[id] || null, {
                shouldHalt () {
                    iter++;
                    return iter > 4096;
                },
            });
            return { s: true, v: res, e: null };
        } catch (err) {
            return { s: false, v: null, e: err.toString() };
        }
    },
    currencies: async (conn) => {
        return currencies;
    },
    convertCurrency: async (conn, { r, fc, tc, v }) => {
        assertType(r, 'object', 'expected r to be an object');
        assertType(fc, 'string', 'expected fc to be a string');
        assertType(tc, 'string', 'expected tc to be a string');
        assertType(v, 'number', 'expected f to be a number');

        const cashify = new Cashify({ base: fc, rates: r });
        return { v: cashify.convert(v, { from: fc, to: tc }) };
    },
    x: async (conn) => {
        conn.flushSendCookies();
        return {};
    },
};

function collectHeaders (headers) {
    const entries = {};
    if (!headers) return entries;
    for (const [k, v] of headers.entries()) {
        entries[k.toLowerCase()] = v;
    }
    return entries;
}
