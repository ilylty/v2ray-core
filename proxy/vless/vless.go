// Package vless contains the implementation of VLESS protocol and transportation.
//
// End-to-end flow (without Mux):
//  1. Client outbound builds a RequestHeader (version, user UUID, addons, command, target address).
//  2. Client sends the request header, then relays payload bytes of one upstream stream.
//  3. Server inbound validates UUID, parses command/target, then dispatches to the destination.
//  4. Server writes a response header and both sides relay payload bidirectionally.
//
// End-to-end flow (with Mux):
//  1. The VLESS request command is RequestCommandMux (target becomes "v1.mux.cool").
//  2. After VLESS authentication succeeds, data is no longer a single raw upstream stream.
//  3. Payload is switched to Mux frames, each frame carrying a logical session ID and metadata.
//  4. Multiple logical TCP/UDP sessions share one physical VLESS transport connection.
//
// VLESS contains both inbound and outbound connections. VLESS inbound is usually used on servers
// together with 'freedom' to talk to final destination, while VLESS outbound is usually used on
// clients with 'socks' for proxying.
package vless

//go:generate go run github.com/v2fly/v2ray-core/v5/common/errors/errorgen
