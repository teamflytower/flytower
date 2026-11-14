# flytower-proxy

Part of Flytower, licensed under the GNU Affero General Public License version 3 (see LICENSE at
the root of https://github.com/teamflytower/flytower).

The way it hooks into the server's network listener (the three classes in
`dev.flytower.proxy.mixin` and `ProxyChannelInitializer`) is adapted from Proxy Protocol Support
by PanSzelescik and jtnqr, https://github.com/PanSzelescik/proxy-protocol-support, under the MIT
licence:

> The MIT License (MIT)
>
> Copyright (c) 2022-2024 PanSzelescik
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The PROXY header reader (`ProxyHeader`, `ProxyDecoder`) is Flytower's own and has no other
dependencies: it doesn't bundle Netty's HAProxy codec.
