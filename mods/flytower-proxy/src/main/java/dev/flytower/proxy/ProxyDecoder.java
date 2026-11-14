package dev.flytower.proxy;

import dev.flytower.proxy.mixin.ConnectionAccessor;
import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import net.minecraft.network.Connection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Sits first in the pipeline of a connection made on this machine. If the connection starts with
 * a PROXY header, it takes the header off and gives the player's real address to Minecraft;
 * otherwise (the panel checking the server, say) it steps aside. Either way it then removes
 * itself, so it costs nothing once the first bytes have arrived.
 */
public final class ProxyDecoder extends ChannelInboundHandlerAdapter {
    static final Logger LOG = LoggerFactory.getLogger("flytower-proxy");

    private final byte[] head = new byte[ProxyHeader.MAX];
    private int have;
    private ByteBuf held;

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        if (!(msg instanceof ByteBuf buf)) {
            ctx.fireChannelRead(msg);
            return;
        }
        held = held == null ? buf : ctx.alloc().compositeBuffer().addComponents(true, held, buf);
        int take = Math.min(held.readableBytes(), head.length) - have;
        if (take > 0) {
            held.getBytes(held.readerIndex() + have, head, have, take);
            have += take;
        }

        switch (ProxyHeader.parse(head, have)) {
            case ProxyHeader.NeedMore ignored -> {
                return;
            }
            case ProxyHeader.Invalid invalid -> {
                LOG.warn("Closed a connection from {} with a broken PROXY header: {}", ctx.channel().remoteAddress(), invalid.reason());
                release();
                ctx.close();
                return;
            }
            case ProxyHeader.Header header -> {
                held.skipBytes(header.length());
                if (header.source() != null && ctx.pipeline().get("packet_handler") instanceof Connection connection) {
                    ((ConnectionAccessor) connection).flytower$setAddress(header.source());
                }
            }
            case ProxyHeader.NotProxy ignored -> {}
        }
        ByteBuf rest = held;
        held = null;
        ctx.pipeline().remove(this);
        if (rest.isReadable()) ctx.fireChannelRead(rest);
        else rest.release();
    }

    @Override
    public void handlerRemoved(ChannelHandlerContext ctx) {
        release();
    }

    private void release() {
        if (held != null) {
            held.release();
            held = null;
        }
    }
}
