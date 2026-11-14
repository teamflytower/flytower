package dev.flytower.proxy;

import dev.flytower.proxy.mixin.ChannelInitializerInvoker;
import io.netty.channel.Channel;
import io.netty.channel.ChannelInitializer;
import java.net.InetSocketAddress;

/**
 * Wraps Minecraft's own channel initializer. After it has set the connection up, connections
 * from this machine get a {@link ProxyDecoder}: the router runs here, and a server behind it
 * listens only on 127.0.0.1. Connections from anywhere else are left exactly as they were, so
 * nobody else can claim to be someone they aren't.
 *
 * <p>Adapted from Proxy Protocol Support by PanSzelescik (MIT); see NOTICE.md.
 */
public final class ProxyChannelInitializer extends ChannelInitializer<Channel> {
    private final ChannelInitializerInvoker minecraft;

    public ProxyChannelInitializer(ChannelInitializerInvoker minecraft) {
        this.minecraft = minecraft;
    }

    @Override
    protected void initChannel(Channel channel) throws Exception {
        minecraft.flytower$initChannel(channel);
        if (channel.remoteAddress() instanceof InetSocketAddress remote
                && remote.getAddress() != null
                && remote.getAddress().isLoopbackAddress()) {
            channel.pipeline().addFirst("flytower-proxy", new ProxyDecoder());
        }
    }
}
