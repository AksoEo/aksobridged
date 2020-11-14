# AKSO Bridge Daemon
## Protocol
When a client connects, the first bytes must be "abx1" or the server will consider the connection invalid and close it. Any following bytes are considered messages.

A message consists of 4 bytes (little endian) for message length followed by the message contents, which are msgpack-encoded objects.

### Messages
All messages have a `t` field in the root object indicating message type (a string), and an `i` field for the message id (a string).
Every client message will receive a response from the server.

#### Client Messages
##### type `hi`
This *must* be the first message a client sends upon establishing a connection. Then, the client must wait for the server to respond before continuing.

Additional fields:

- `api` (str) api host
- `ip`: (str) proxied client IP address (used for rate limiting)
- `co`: an object mapping cookie names to cookie values which will be passed verbatim to the AKSO API. Should be used to send the client’s session cookies.

##### type `hic`
This *must* be the first message a client sends upon establishing a connection. Then, the client must wait for the server to respond before continuing.

This establishes the client as an API client. Various login-related methods will most likely break in this mode.

Additional fields:
- `api`: (str) api host
- `key`: (str) api key
- `sec`: (str) api secret

##### type `login`
Additional fields:

- `un`: (str) username
- `pw`: (str) password

##### type `logout`

##### type `totp`
Additional fields:

- `co`: (str) totp code
- `se`: (str?) totp secret. Only present if TOTP is being set up.
- `r`: (bool) if true, the user device should be remembered for 60 days

##### type `-totp`

##### type `get`
Additional fields:

- `p`: (str) path
- `q`: (object) query
- `c`: (number) seconds to cache this resource for. 0 will not cache. negative numbers will panic.

##### type `delete`
Additional fields:

- `p`: (str) path
- `q`: (object) query

##### type `post`
Additional fields:

- `p`: (str) path
- `b`: (object|null) body
- `q`: (object) query
- `f`: (object) files
    + name ↦ object
        * `t`: (str) mime type
        * `b`: (Buffer) file buffer

##### type `put`
Additional fields:

- `p`: (str) path
- `b`: (object|null) body
- `q`: (object) query
- `f`: (object) files
    + name ↦ object
        * `t`: (str) mime type
        * `b`: (Buffer) file buffer

##### type `patch`
Additional fields:

- `p`: (str) path
- `b`: (object|null) body
- `q`: (object) query

##### type `perms`
Additional fields:

- `p`: (str[]) perms to check

##### type `permscf`
Additional fields:

- `f`: (str[]) codeholder fields formatted like `field.rw` to check

##### type `permsocf`
Additional fields:

- `f`: (str[]) own codeholder fields formatted like `field.rw` to check

##### type `regexp`
Additional fields:

- `r`: (str) regexp string
- `s`: (str) test string

##### type `asc`
Additional fields:

- `s`: (object[]) array of script objects
- `fv`: (object) form vars
- `e`: (object) expr to evaluate

##### type `currencies`

##### type `convertCurrency`
Additional fields:

- `r`: (obj) rates as { [currency]: value }
- `fc`: (str) currency to convert from (should be base for `r`)
- `tc`: (str) currency to convert to
- `v`: (number) float value

##### type `x`
Gracefully closes the connection.

#### Server Responses
Server responses always have `t` set to the string `~` or `~!`.

If the type is `~!` the server encountered an unexpected error. The message will contain a `m` field with a human-readable error string.

##### type `hi`
ACK. Additional fields:

- `auth`: (bool) if true, there is a user session

Additional fields if `auth` is true:

- `uea`: (str) uea code
- `id`: (number) user id
- `totp`: (bool) if true, the user still needs to use TOTP
- `member`: (bool) if true, the user is an active member

##### type `hic`
ACK.

##### type `login`
Additional fields:

- `s`: (bool) if true, login succeeded.

Additional fields if `s` is true:

- `uea`: (str) uea code
- `id`: (number) user id
- `totp`: (bool) if true, the user still needs to use TOTP
- `member`: (bool) if true, the user is an active member

Additional fields if `s` is false:

- `nopw`: (bool) if true, the user has no password. If false, the user entered a wrong user/password combination.

##### type `logout`
Additional fields:

- `s`: (bool) if true, logging out succeeded. If false, there was no user session.

##### type `totp`
Additional fields:

- `s` (bool) if true, login succeeded.

Additional fields if `s` is false:

- `bad`: (bool) if true, the user has already signed in using TOTP, it has already been set up, or the user still needs to set up TOTP first.
- `nosx`: (bool) if true, there is no user session.

##### type `-totp`
Additional fields:

- `s` (bool) if true, deleting TOTP succeeded.

##### type `get`, `delete`, `post`, `put`, `patch`
Additional fields:

- `k`: (bool) response is okay
- `sc`: (number) status code
- `h`: (object) response headers (e.g. x-total-items)
- `b`: (any?) response body

##### type `perms`
Additional fields:

- `p`: (bool[]) whether the individual permissions are granted; in the same order as the input

##### type `permscf`
Additional fields:

- `f`: (bool[]) whether the individual codeholder field permissions are granted; in the same order as the input

##### type `permsocf`
Additional fields:

- `f`: (bool[]) whether the individual own codeholder field permissions are granted; in the same order as the input

##### type `regexp`
Additional fields:

- `m`: (bool) true if the pattern matches

##### type `asc`
Additional fields:

- `s`: (bool) success
- `v`: (any) if success, expr value
- `e`: (string) error if not successful

##### type `currencies`
Returns the AKSO Script `currencies` object.

##### type `convertCurrency`
Additional fields:

- `v`: (num) converted value (float)

##### type `x`
ACK.

#### Server Messages
##### type `co`
Tells the client to set user cookies.

Additional fields:

- `co`: (string[]) a list of set-cookie header values

##### type `TXERR`
A protocol error. The server will subsequently close the connection.

Additional fields:

- `c`: (number) an error code
- `m`: (string) a human readable error string

##### type `❤`
This is a heartbeat message to keep the socket from timing out during slow operations.

###### Error codes
- `100`: bad magic number
- `101`: insane message length (negative message length or one that is too large)
- `102`: message decode error
- `103`: timed out
- `200`: unknown message type
