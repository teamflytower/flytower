package dev.flytower.proxy.mixin;

import dev.flytower.proxy.ProxyChannelInitializer;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.ChannelHandler;
import net.minecraft.server.network.ServerConnectionListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/**
 * Wraps the initializer the server gives each new connection in {@link ProxyChannelInitializer}.
 * Adapted from Proxy Protocol Support by PanSzelescik (MIT); see NOTICE.md.
 */
@Mixin(ServerConnectionListener.class)
public abstract class ServerConnectionListenerMixin {
    @Redirect(
            method = "startTcpServerListener",
            at = @At(
                    value = "INVOKE",
                    target = "Lio/netty/bootstrap/ServerBootstrap;childHandler(Lio/netty/channel/ChannelHandler;)Lio/netty/bootstrap/ServerBootstrap;",
                    remap = false))
    private ServerBootstrap flytower$wrapChildHandler(ServerBootstrap bootstrap, ChannelHandler minecraft) {
        return bootstrap.childHandler(new ProxyChannelInitializer((ChannelInitializerInvoker) minecraft));
    }
}
