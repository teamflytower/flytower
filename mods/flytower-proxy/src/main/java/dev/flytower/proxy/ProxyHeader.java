package dev.flytower.proxy;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.util.Arrays;

/**
 * Reads a PROXY protocol version 2 header, the only kind the hostname router sends. See
 * https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt, section 2.2.
 */
public final class ProxyHeader {
    static final byte[] SIGNATURE = {0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A};
    /** The fixed part: signature, version and command, family, length. */
    static final int FIXED = 16;
    /** The longest header accepted. TLVs past the addresses are skipped, but not without limit. */
    static final int MAX = FIXED + 512;

    /** What the first bytes of a connection turned out to be. */
    public sealed interface Result permits NeedMore, NotProxy, Header, Invalid {}

    /** Not enough bytes yet to tell. */
    public record NeedMore() implements Result {}

    /** The connection doesn't start with a header: an ordinary Minecraft client. */
    public record NotProxy() implements Result {}

    /**
     * A complete header of {@code length} bytes. {@code source} is the player's address, or null
     * for a LOCAL header (a health check) or an address family other than TCP over IPv4 or IPv6.
     */
    public record Header(int length, InetSocketAddress source) implements Result {}

    /** It starts like a header but breaks the format; the connection should be closed. */
    public record Invalid(String reason) implements Result {}

    private ProxyHeader() {}

    /** Reads {@code len} bytes from the start of {@code buf}. */
    public static Result parse(byte[] buf, int len) {
        int sig = Math.min(len, SIGNATURE.length);
        if (!Arrays.equals(buf, 0, sig, SIGNATURE, 0, sig)) return new NotProxy();
        if (len < FIXED) return new NeedMore();

        int versionCommand = buf[12] & 0xFF;
        if (versionCommand >> 4 != 2) return new Invalid("version " + (versionCommand >> 4));
        int command = versionCommand & 0x0F;
        if (command > 1) return new Invalid("command " + command);
        int family = buf[13] & 0xFF;
        int rest = ((buf[14] & 0xFF) << 8) | (buf[15] & 0xFF);
        int length = FIXED + rest;
        if (length > MAX) return new Invalid("header of " + length + " bytes");
        if (len < length) return new NeedMore();
        if (command == 0) return new Header(length, null); // LOCAL

        int addressBytes;
        switch (family) {
            case 0x11 -> addressBytes = 4; // TCP over IPv4
            case 0x21 -> addressBytes = 16; // TCP over IPv6
            default -> {
                return new Header(length, null);
            }
        }
        if (rest < addressBytes * 2 + 4) return new Invalid("addresses don't fit in " + rest + " bytes");
        try {
            InetAddress source = InetAddress.getByAddress(Arrays.copyOfRange(buf, FIXED, FIXED + addressBytes));
            int at = FIXED + addressBytes * 2;
            int port = ((buf[at] & 0xFF) << 8) | (buf[at + 1] & 0xFF);
            return new Header(length, new InetSocketAddress(source, port));
        } catch (UnknownHostException e) {
            return new Invalid(e.getMessage()); // can't happen for 4 or 16 bytes
        }
    }
}
