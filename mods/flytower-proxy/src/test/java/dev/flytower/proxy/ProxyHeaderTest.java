package dev.flytower.proxy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class ProxyHeaderTest {
    private static final HexFormat HEX = HexFormat.of();

    private static String field(String line, String name) {
        Matcher m = Pattern.compile("\"" + name + "\":\"([^\"]*)\"").matcher(line);
        return m.find() ? m.group(1) : null;
    }

    private static InetSocketAddress address(String s) {
        int colon = s.lastIndexOf(':');
        String host = s.substring(0, colon).replace("[", "").replace("]", "");
        return new InetSocketAddress(host, Integer.parseInt(s.substring(colon + 1)));
    }

    /** Every header the router writes (protocol/fixtures/proxy-v2.jsonl) reads back to the player's address. */
    @Test
    void readsTheRoutersHeaders() throws Exception {
        List<String> lines = Files.readAllLines(Path.of(System.getProperty("fixtures"), "proxy-v2.jsonl"));
        assertFalse(lines.isEmpty());
        for (String line : lines) {
            byte[] header = HEX.parseHex(field(line, "header"));
            String source = field(line, "source") != null ? field(line, "source") : field(line, "src");
            // With a Minecraft handshake straight after, as the router sends it.
            byte[] buf = new byte[header.length + 3];
            System.arraycopy(header, 0, buf, 0, header.length);
            buf[header.length] = 0x10;
            var result = assertInstanceOf(ProxyHeader.Header.class, ProxyHeader.parse(buf, buf.length), field(line, "note"));
            assertEquals(header.length, result.length(), field(line, "note"));
            assertEquals(address(source), result.source(), field(line, "note"));

            // Arriving a byte at a time, it needs more until the last byte of the header.
            for (int n = 1; n < header.length; n++) {
                assertInstanceOf(ProxyHeader.NeedMore.class, ProxyHeader.parse(header, n), field(line, "note") + " at " + n);
            }
        }
    }

    @Test
    void leavesMinecraftClientsAlone() {
        // A handshake whose length byte happens to match the signature's first byte.
        byte[] handshake = {0x0D, 0x00, (byte) 0xF6, 0x05, 0x09, 'l', 'o', 'c', 'a', 'l', 'h', 'o', 's', 't'};
        assertInstanceOf(ProxyHeader.NotProxy.class, ProxyHeader.parse(handshake, handshake.length));
        assertInstanceOf(ProxyHeader.NotProxy.class, ProxyHeader.parse(handshake, 2));
        // The legacy server list ping.
        assertInstanceOf(ProxyHeader.NotProxy.class, ProxyHeader.parse(new byte[] {(byte) 0xFE, 0x01}, 2));
        // Version 1's text header isn't something the router sends.
        byte[] v1 = "PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n".getBytes(StandardCharsets.US_ASCII);
        assertInstanceOf(ProxyHeader.NotProxy.class, ProxyHeader.parse(v1, v1.length));
    }

    @Test
    void localHeadersKeepTheAddress() {
        byte[] local = HEX.parseHex("0d0a0d0a000d0a515549540a" + "20" + "00" + "0000");
        var result = assertInstanceOf(ProxyHeader.Header.class, ProxyHeader.parse(local, local.length));
        assertEquals(16, result.length());
        assertNull(result.source());
    }

    @Test
    void skipsTlvsAfterTheAddresses() {
        byte[] withTlv = HEX.parseHex("0d0a0d0a000d0a515549540a2111" + "0010" + "cb007107c0000201c73863dd" + "04000100");
        var result = assertInstanceOf(ProxyHeader.Header.class, ProxyHeader.parse(withTlv, withTlv.length));
        assertEquals(32, result.length());
        assertEquals(new InetSocketAddress("203.0.113.7", 51000), result.source());
    }

    @Test
    void refusesBrokenHeaders() {
        String sig = "0d0a0d0a000d0a515549540a";
        for (String bad : List.of(
                sig + "11" + "11" + "000c" + "cb007107c0000201c73863dd", // version 1 in a v2 header
                sig + "22" + "11" + "000c" + "cb007107c0000201c73863dd", // unknown command
                sig + "21" + "11" + "0008" + "cb007107c0000201", // addresses cut short
                sig + "21" + "11" + "ffff")) { // far too long
            byte[] b = HEX.parseHex(bad);
            assertInstanceOf(ProxyHeader.Invalid.class, ProxyHeader.parse(b, b.length), bad);
        }
    }
}
