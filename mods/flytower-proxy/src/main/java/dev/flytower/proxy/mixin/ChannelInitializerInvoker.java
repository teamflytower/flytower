package dev.flytower.proxy.mixin;

import io.netty.channel.Channel;
import io.netty.channel.ChannelInitializer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Lets {@code ProxyChannelInitializer} run Minecraft's own initializer. Adapted from Proxy Protocol Support (MIT); see NOTICE.md. */
@Mixin(ChannelInitializer.class)
public interface ChannelInitializerInvoker {
    @Invoker(value = "initChannel", remap = false)
    void flytower$initChannel(Channel channel) throws Exception;
}
