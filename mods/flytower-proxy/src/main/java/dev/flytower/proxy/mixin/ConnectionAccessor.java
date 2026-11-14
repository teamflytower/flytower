package dev.flytower.proxy.mixin;

import java.net.SocketAddress;
import net.minecraft.network.Connection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Lets {@code ProxyDecoder} set the player's address. Adapted from Proxy Protocol Support (MIT); see NOTICE.md. */
@Mixin(Connection.class)
public interface ConnectionAccessor {
    @Accessor("address")
    void flytower$setAddress(SocketAddress address);
}
