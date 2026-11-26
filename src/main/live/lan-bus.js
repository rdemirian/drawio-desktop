// Finds peers on the local network without any server: UDP multicast
// (administratively scoped, TTL 1, so it never leaves the LAN). Carries
// presence beacons and WebRTC signalling, both sealed with the session key.

import dgram from 'dgram';
import { EventEmitter } from 'events';

export const LAN_GROUP = '239.255.77.88';
export const LAN_PORT = 41999;
const MAX_PACKET = 60000;

export class LanBus extends EventEmitter
{
	constructor(opts = {})
	{
		super();
		this.group = opts.group || LAN_GROUP;
		this.port = opts.port || LAN_PORT;
		this.log = opts.log || (() => {});
		this.socket = null;
		this.ready = null;
	}

	start()
	{
		if (this.ready != null) return this.ready;

		this.ready = new Promise((resolve) =>
		{
			const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
			this.socket = socket;

			socket.on('error', (e) =>
			{
				this.log('live: LAN bus error', e.message);
				this.emit('error', e);
				resolve(false);
			});

			socket.on('message', (buf, rinfo) =>
			{
				if (buf.length > MAX_PACKET) return;

				let packet;

				try
				{
					packet = JSON.parse(buf.toString('utf8'));
				}
				catch (e)
				{
					return;
				}

				if (packet != null && packet.app == 'drawio-live' && packet.v == 1)
				{
					this.emit('packet', packet, rinfo);
				}
			});

			socket.bind(this.port, () =>
			{
				try
				{
					socket.addMembership(this.group);
					socket.setMulticastLoopback(true);
					socket.setMulticastTTL(1);
					resolve(true);
				}
				catch (e)
				{
					this.log('live: multicast unavailable', e.message);
					resolve(false);
				}
			});
		});

		return this.ready;
	}

	async send(packet)
	{
		if (!(await this.start())) return false;

		const buf = Buffer.from(JSON.stringify(Object.assign({app: 'drawio-live', v: 1}, packet)), 'utf8');

		if (buf.length > MAX_PACKET)
		{
			this.log('live: LAN packet too large', buf.length);
			return false;
		}

		return new Promise((resolve) =>
		{
			this.socket.send(buf, this.port, this.group, (err) => resolve(err == null));
		});
	}

	stop()
	{
		try { this.socket?.close(); } catch (e) {}
		this.socket = null;
		this.ready = null;
	}
}
