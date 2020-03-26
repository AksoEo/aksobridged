# AKSO Bridge Daemon
## Protocol
When a client connects, the first bytes must be "abx1" or the server will consider the connection invalid and close it. Any following bytes are considered messages.

A message consists of 4 bytes (little endian) for message length followed by the message contents, which are msgpack-encoded objects.

### Messages
All messages have a `t` field in the root object indicating message type (a string), and an `i` field for the message id.
Every client message will receive a response from the server.

#### Client Messages
##### type `hi`
This *must* be the first message a client sends upon establishing a connection. Then, the client must wait for the server to respond before continuing.

Additional fields:

- `ip`: (str) proxied client IP address (used for rate limiting)
- `co`: an object mapping cookie names to cookie values which will be passed verbatim to the AKSO API. Should be used to send the client’s session cookies.

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

#### Server Responses
Server responses always have `t` set to the string `~`.

##### type `hi`
ACK. Additional fields:

- `auth`: (bool) if true, there is a user session

Additional fields if `auth` is true:

- `uea`: (str) uea code
- `id`: (number) user id

##### type `login`
Additional fields:

- `s`: (bool) if true, login succeeded.

Additional fields if `s` is true:

- `uea`: (str) uea code
- `id`: (number) user id
- `totp`: (bool) if true, the user has set up TOTP

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

#### Server Messages
##### type `co`
Tells the client to set user cookies.

Additional fields:

- `co`: an object mapping cookie names to cookie values
