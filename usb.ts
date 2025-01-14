import { once, EventEmitter } from "events";

import {
	CapabilityDescriptor,
	Device,
	Endpoint as EndpointType,
	OutEndpoint as OutEndpointType,
	InEndpoint as InEndpointType,
	EndpointDescriptor, Transfer,
	Interface as InterfaceType,
	InterfaceDescriptor,
	ConfigDescriptor,
	BosDescriptor,
	DeviceDescriptor
} from "./types";

export { Constants } from "./constants";
export * from "./types";

const usb = require("bindings")("usb_bindings")
export default usb as EventEmitter;

if (usb.INIT_ERROR) {
	console.warn("Failed to initialize libusb.")
	usb.Device = function () { throw new Error("Device cannot be instantiated directly.") };
	usb.Transfer = function () { throw new Error("Transfer cannot be instantiated directly.") };
	usb.setDebugLevel = function () { };
	usb.getDeviceList = function () { return []; };
	usb._enableHotplugEvents = function () { };
	usb._disableHotplugEvents = function () { };
}

// mixin EventEmitter for hotplug events.
Object.keys(EventEmitter.prototype).forEach(function (key) {
	usb[key] = EventEmitter.prototype[key];
});

let hotplugListeners = 0;
usb.on('newListener', function (name) {
	if (name !== 'attach' && name !== 'detach') return;
	if (++hotplugListeners === 1) {
		usb._enableHotplugEvents();
	}
});

usb.on('removeListener', function (name) {
	if (name !== 'attach' && name !== 'detach') return;
	if (--hotplugListeners === 0) {
		usb._disableHotplugEvents();
	}
});

usb.Device.prototype.timeout = 1000;

const SETUP_SIZE = usb.LIBUSB_CONTROL_SETUP_SIZE

// Extensions on the NAPI Device class
class DeviceExtensions {
	timeout: number;
	interfaces: Interface[];
	_bosDescriptor: BosDescriptor;
	deviceDescriptor: DeviceDescriptor;

	get parent(): Device {
		const self = this as any;
		return self._parent || (self._parent = self.__getParent())
	}

	get configDescriptor(): ConfigDescriptor {
		try {
			const self = this as any;
			return self._configDescriptor || (self._configDescriptor = self.__getConfigDescriptor())
		} catch (e) {
			// Check descriptor exists
			if (e.errno == usb.LIBUSB_ERROR_NOT_FOUND) return null;
			throw e;
		}
	}

	get allConfigDescriptors(): ConfigDescriptor[] {
		try {
			const self = this as any;
			return self._allConfigDescriptors || (self._allConfigDescriptors = self.__getAllConfigDescriptors())
		} catch (e) {
			// Check descriptors exist
			if (e.errno == usb.LIBUSB_ERROR_NOT_FOUND) return [];
			throw e;
		}
	}

	close() {
		const self = this as any;
		self.__close()
		self.interfaces = null
	}

	open() {
		const self = this as any;
		self.__open()
		this.interfaces = []
		const len = this.configDescriptor ? this.configDescriptor.interfaces.length : 0
		for (let i = 0; i < len; i++) {
			this.interfaces[i] = new Interface(this as any as Device, i)
		}
	}

	interface(addr: number) {
		if (!this.interfaces) {
			throw new Error("Device must be open before searching for interfaces")
		}
		addr = addr || 0
		for (let i = 0; i < this.interfaces.length; i++) {
			if (this.interfaces[i].interfaceNumber == addr) {
				return this.interfaces[i]
			}
		}
	}

	async getStringDescriptor(desc_index: number): Promise<string> {
		const langid = 0x0409;
		const length = 255;
		const buf = await this.controlTransfer(
			usb.LIBUSB_ENDPOINT_IN,
			usb.LIBUSB_REQUEST_GET_DESCRIPTOR,
			((usb.LIBUSB_DT_STRING << 8) | desc_index),
			langid,
			length);
		const ret = buf.toString('utf16le', 2);
        const termination = ret.indexOf('\0');
        if (termination !== -1)
            return ret.substring(0, termination);
        return ret;
	}

	async getBosDescriptor(): Promise<BosDescriptor> {

		if (this._bosDescriptor) {
			// Cached descriptor
			return this._bosDescriptor;
		}

		if (this.deviceDescriptor.bcdUSB < 0x201) {
			// BOS is only supported from USB 2.0.1
			return null;
		}
		try {
			let buffer = await this.controlTransfer(
				usb.LIBUSB_ENDPOINT_IN,
				usb.LIBUSB_REQUEST_GET_DESCRIPTOR,
				(usb.LIBUSB_DT_BOS << 8),
				0,
				usb.LIBUSB_DT_BOS_SIZE);

			const totalLength = buffer.readUInt16LE(2);
			buffer = await this.controlTransfer(
				usb.LIBUSB_ENDPOINT_IN,
				usb.LIBUSB_REQUEST_GET_DESCRIPTOR,
				(usb.LIBUSB_DT_BOS << 8),
				0,
				totalLength);

			const descriptor = {
				bLength: buffer.readUInt8(0),
				bDescriptorType: buffer.readUInt8(1),
				wTotalLength: buffer.readUInt16LE(2),
				bNumDeviceCaps: buffer.readUInt8(4),
				capabilities: []
			};

			let i = usb.LIBUSB_DT_BOS_SIZE;
			while (i < descriptor.wTotalLength) {
				const bLength = buffer.readUInt8(i + 0);
				const capability = {
					bLength,
					bDescriptorType: buffer.readUInt8(i + 1),
					bDevCapabilityType: buffer.readUInt8(i + 2),
					dev_capability_data: buffer.slice(i + 3, i + bLength)
				};

				descriptor.capabilities.push(capability);
				i += capability.bLength;
			}

			// Cache descriptor
			this._bosDescriptor = descriptor;
			return this._bosDescriptor;
		}
		catch (error) {
			// Check BOS descriptor exists
			if (error.errno === usb.LIBUSB_TRANSFER_STALL) return null;
			throw error;
		}
	}

	async getCapabilities(): Promise<Capability[]> {
		const capabilities = [];
		const self = this;

		const descriptor = await this.getBosDescriptor()
		const len = descriptor ? descriptor.capabilities.length : 0
		for (let i = 0; i < len; i++) {
			capabilities.push(new Capability(self, i))
		}
		return capabilities;
	}

	async setConfiguration(desired: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const self = this as any;
			self.__setConfiguration(desired, function (err) {
				if (err) return reject(err);
				this.interfaces = []
				const len = this.configDescriptor ? this.configDescriptor.interfaces.length : 0
				for (let i = 0; i < len; i++) {
					this.interfaces[i] = new Interface(this, i)
				}
				resolve(null)
			});
		});
	}

	async reset(): Promise<void> {
		return new Promise((resolve, reject) => {
			const self = this as any;
			self.__reset(function (err) {
				if (err) return reject(err);
				resolve(null)
			});
		})
	}

	async controlTransfer(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, data_or_length: number | Buffer): Promise<Buffer | undefined> {
		const isIn = !!(bmRequestType & usb.LIBUSB_ENDPOINT_IN)
		let wLength: number

		if (isIn) {
			if (!(data_or_length >= 0)) {
				throw new TypeError("Expected size number for IN transfer (based on bmRequestType)")
			}
			wLength = data_or_length as number
		} else {
			if (!isBuffer(data_or_length)) {
				throw new TypeError("Expected buffer for OUT transfer (based on bmRequestType)")
			}
			wLength = (data_or_length as Buffer).length
		}

		// Buffer for the setup packet
		// http://libusbx.sourceforge.net/api-1.0/structlibusb__control__setup.html
		const buf = Buffer.alloc(wLength + SETUP_SIZE)
		buf.writeUInt8(bmRequestType, 0)
		buf.writeUInt8(bRequest, 1)
		buf.writeUInt16LE(wValue, 2)
		buf.writeUInt16LE(wIndex, 4)
		buf.writeUInt16LE(wLength, 6)

		if (!isIn) {
			buf.set(data_or_length as Buffer, SETUP_SIZE)
		}

		return new Promise((resolve, reject) => {
			const transfer = new usb.Transfer(this, 0, usb.LIBUSB_TRANSFER_TYPE_CONTROL, this.timeout,
				(error, buf, actual) => {
					if (error) return reject(error);

					if (isIn) {
						resolve(buf.slice(SETUP_SIZE, SETUP_SIZE + actual));
					} else {
						resolve(null);
					}
				}
			);

			transfer.submit(buf)
		})
	}
}

Object.getOwnPropertyNames(DeviceExtensions.prototype).filter(key => key !== 'constructor').forEach(key => {
	const d = Object.getOwnPropertyDescriptor(DeviceExtensions.prototype, key);
	if (d.get) {
		Object.defineProperty(usb.Device.prototype, key, {
			get: d.get,
		});
	}
	else {
		usb.Device.prototype[key] = d.value;
	}
});

/**
 * Return a list of `Device` objects for the USB devices attached to the system.
 */
 export function getDeviceList(): Device[] {
	return usb.getDeviceList();
}

function isBuffer(obj: any) {
	return obj && obj instanceof Uint8Array
}

// convenience method for finding a device by vendor and product id
export function findByIds(vid, pid) {
	const devices = usb.getDeviceList()

	for (let i = 0; i < devices.length; i++) {
		const deviceDesc = devices[i].deviceDescriptor
		if ((deviceDesc.idVendor == vid) && (deviceDesc.idProduct == pid)) {
			return devices[i]
		}
	}
}

class Interface implements InterfaceType {
	device: Device;
	id: number;
	altSetting = 0;
	descriptor: InterfaceDescriptor;
	interfaceNumber: number;
	endpoints: Endpoint[];

	constructor(device: Device, id: number) {
		this.device = device
		this.id = id
		this.__refresh()
	}

	__refresh() {
		this.descriptor = this.device.configDescriptor.interfaces[this.id][this.altSetting]
		this.interfaceNumber = this.descriptor.bInterfaceNumber
		this.endpoints = []
		const len = this.descriptor.endpoints.length
		for (let i = 0; i < len; i++) {
			const desc = this.descriptor.endpoints[i]
			const c = (desc.bEndpointAddress & usb.LIBUSB_ENDPOINT_IN) ? InEndpoint : OutEndpoint
			this.endpoints[i] = new c(this.device, desc)
		}
	}

	claim() {
		this.device.__claimInterface(this.id)
	}

	async release(closeEndpoints?: boolean): Promise<void> {
		return new Promise((resolve, reject) => {
			const self = this;

			if (!closeEndpoints || this.endpoints.length == 0) {
				next();
			} else {
				let n = self.endpoints.length;
				self.endpoints.forEach(function (ep, _i) {
					if (ep.pollActive) {
						ep.once('end', function () {
							if (--n == 0) next();
						});
						ep.stopPoll();
					} else {
						if (--n == 0) next();
					}
				});
			}

			function next() {
				(self.device as any).__releaseInterface(self.id, function (err) {
					if (err) return reject(err);
					self.altSetting = 0;
					self.__refresh()
					resolve(null)
				})
			}
		})

	}

	isKernelDriverActive() {
		return this.device.__isKernelDriverActive(this.id)
	}

	detachKernelDriver() {
		return this.device.__detachKernelDriver(this.id)
	};

	attachKernelDriver() {
		return this.device.__attachKernelDriver(this.id)
	};

	async setAltSetting(altSetting): Promise<void> {
		return new Promise((resolve, reject) => {
			const self = this;
			(this.device as any).__setInterface(this.id, altSetting, function (err) {
				if (err) return reject(err);
				self.altSetting = altSetting;
				self.__refresh();
				resolve(null);
			})
		});
	}

	endpoint(addr: number) {
		for (let i = 0; i < this.endpoints.length; i++) {
			if (this.endpoints[i].address == addr) {
				return this.endpoints[i]
			}
		}
	}
}

class Capability {
	device: Device;
	id: number;
	descriptor: CapabilityDescriptor;
	type: number;
	data: Buffer;
	constructor(device, id) {
		this.device = device
		this.id = id
		this.descriptor = (this.device as any)._bosDescriptor.capabilities[this.id]
		this.type = this.descriptor.bDevCapabilityType
		this.data = this.descriptor.dev_capability_data
	}
}

class Endpoint extends EventEmitter implements EndpointType {
	device: Device;
	descriptor: EndpointDescriptor;
	address: number;
	transferType: number;
	timeout = 0;
	direction: string;
	pollTransfers: Transfer[];
	pollTransferSize: number;
	pollActive: boolean;
	pollPending: number;

	constructor(device: Device, descriptor: EndpointDescriptor) {
		super();
		this.device = device
		this.descriptor = descriptor
		this.address = descriptor.bEndpointAddress
		this.transferType = descriptor.bmAttributes & 0x03
	}

	async clearHalt(): Promise<void> {
		return new Promise((resolve, reject) => {
			(this.device as any).__clearHalt(this.address, (err) => {
				if (err) return reject(err);
				resolve(null);
			});
		});
	}

	makeTransfer(timeout, callback) {
		return new usb.Transfer(this.device, this.address, this.transferType, timeout, callback)
	}

	startPollInternal(nTransfers?: number, transferSize?: number, callback?) {
		if (this.pollTransfers) {
			throw new Error("Polling already active")
		}

		nTransfers = nTransfers || 3;
		this.pollTransferSize = transferSize || this.descriptor.wMaxPacketSize;
		this.pollActive = true
		this.pollPending = 0

		const transfers = []
		for (let i = 0; i < nTransfers; i++) {
			transfers[i] = this.makeTransfer(0, callback)
		}
		return transfers;
	}

	async stopPoll(): Promise<void> {
		if (!this.pollTransfers) {
			throw new Error('Polling is not active.');
		}
		for (let i = 0; i < this.pollTransfers.length; i++) {
			try {
				this.pollTransfers[i].cancel()
			} catch (err) {
				this.emit('error', err);
			}
		}
		this.pollActive = false
		await once(this, 'end');
	}
}

class InEndpoint extends Endpoint implements InEndpointType {
	direction = "in"

	constructor(device: Device, descriptor: EndpointDescriptor) {
		super(device, descriptor);
	}


	async transfer(length: number): Promise<Buffer> {
		const buffer = Buffer.alloc(length)

		return new Promise((resolve, reject) => {
			this.makeTransfer(this.timeout, (error: any, _buf: any, actual: number) => {
				if (error) return reject(error);
				resolve(buffer.subarray(0, actual));
			}).submit(buffer)
		})
	}

	startPoll(nTransfers?: number, transferSize?: number) {
		const self = this
		this.pollTransfers = this.startPollInternal(nTransfers, transferSize, transferDone)

		function transferDone(error, buf, actual) {
			if (!error) {
				self.emit("data", buf.slice(0, actual))
			} else if (error.errno != usb.LIBUSB_TRANSFER_CANCELLED) {
				self.emit("error", error)
				self.stopPoll()
			}

			if (self.pollActive) {
				startTransfer(this)
			} else {
				self.pollPending--

				if (self.pollPending == 0) {
					delete self.pollTransfers;
					self.emit('end')
				}
			}
		}

		function startTransfer(t) {
			try {
				t.submit(Buffer.alloc(self.pollTransferSize), transferDone);
			} catch (e) {
				self.emit("error", e);
				self.stopPoll();
			}
		}

		this.pollTransfers.forEach(startTransfer)
		self.pollPending = this.pollTransfers.length
	}
}

class OutEndpoint extends Endpoint implements OutEndpointType {
	direction = "out"

	constructor(device: Device, descriptor: EndpointDescriptor) {
		super(device, descriptor)
	}

	async transfer(buffer: Buffer): Promise<void> {
		if (!buffer) {
			buffer = Buffer.alloc(0)
		} else if (!isBuffer(buffer)) {
			buffer = Buffer.from(buffer)
		}

		return new Promise((resolve, reject) => {
			this.makeTransfer(this.timeout, (error, _buf?, _actual?) => {
				if (error) return reject(error);
				resolve(null);

			}).submit(buffer);
		})
	}

	async transferWithZLP(buf: Buffer) {
		if (buf.length % this.descriptor.wMaxPacketSize == 0) {
			await this.transfer(buf);
			await this.transfer(Buffer.alloc(0));
		} else {
			await this.transfer(buf);
		}
	}
}
