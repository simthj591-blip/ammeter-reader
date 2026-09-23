'use strict';

const $ = id => document.getElementById(id);
const KEY = 'passive-ammeter-records-v1';
const HC08_SERVICE_UUID = 0xffe0;
const HC08_CHARACTERISTIC_UUID = 0xffe1;
const AUTO_READ_PERIOD_MS = 120000;
const AUTO_OFFLINE_MS = 130000;
const RESPONSE_TIMEOUT_MS = 5000;

let records = JSON.parse(localStorage.getItem(KEY) || '[]');
const meters = new Map();
const links = new Map();
let autoTimer = null;

for (let i = 0; i < 16; i++) {
  const address = i.toString(16).toUpperCase();
  $('address').add(new Option(address, address));
}

function crc8(text) {
  let crc = 0;
  for (const character of text) {
    crc ^= character.charCodeAt(0);
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function parse(text) {
  const match = text.match(/M1[0-9A-F][0-9]{4}[0-9A-F]{3}[0-9A-F]{2}/i);
  if (!match) return null;

  const frame = match[0].toUpperCase();
  if (crc8(frame.slice(0, 10)) !== parseInt(frame.slice(10), 16)) return null;

  return {
    address: frame[2],
    mA: Number(frame.slice(3, 7)),
    flags: parseInt(frame[7], 16),
    seq: parseInt(frame.slice(8, 10), 16)
  };
}

function bytesText(view) {
  return new TextDecoder().decode(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  );
}

function statusOf(meter, offline = false) {
  if (offline) return 'OFFLINE';
  if (meter.flags & 0x04) return 'ERROR';
  if (meter.flags & 0x08) return 'UNCAL';
  if (meter.mA < 200 || meter.flags & 0x01) return 'LOW';
  if (meter.mA > 2000 || meter.flags & 0x02) return 'HIGH';
  return 'NORMAL';
}

function accept(meter) {
  if ($('mode').value === 'basic' && meter.address !== $('address').value) return;

  const now = Date.now();
  const old = meters.get(meter.address);
  const basicMode = $('mode').value === 'basic';

  meter.time = now;
  meter.saved = old?.saved || 0;

  if (basicMode || !old || now - meter.saved >= AUTO_READ_PERIOD_MS) {
    meter.saved = now;
    records.push({
      time: now,
      address: meter.address,
      mA: meter.mA,
      state: statusOf(meter)
    });

    if (records.length > 500) records = records.slice(-500);
    localStorage.setItem(KEY, JSON.stringify(records));
  }

  meters.set(meter.address, meter);
  render();
}

function createLink(device) {
  let link = links.get(device.id);
  if (link) return link;

  link = {
    device,
    characteristic: null,
    address: null,
    rxText: '',
    responseTimer: null
  };

  device.addEventListener('gattserverdisconnected', () => {
    link.characteristic = null;
    link.rxText = '';
  });

  links.set(device.id, link);
  return link;
}

async function ensureConnected(link) {
  if (link.device.gatt.connected && link.characteristic) {
    return link.characteristic;
  }

  const server = link.device.gatt.connected
    ? link.device.gatt
    : await link.device.gatt.connect();

  const service = await server.getPrimaryService(HC08_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(HC08_CHARACTERISTIC_UUID);

  await characteristic.startNotifications();
  characteristic.addEventListener(
    'characteristicvaluechanged',
    event => handleNotification(link, event)
  );

  link.characteristic = characteristic;
  return characteristic;
}

function disconnectLink(link) {
  if (link.responseTimer !== null) {
    clearTimeout(link.responseTimer);
    link.responseTimer = null;
  }

  if (link.device.gatt.connected) link.device.gatt.disconnect();
  link.characteristic = null;
}

function handleNotification(link, event) {
  link.rxText += bytesText(event.target.value);

  while (true) {
    const match = link.rxText.match(/M1[0-9A-F][0-9]{4}[0-9A-F]{3}[0-9A-F]{2}/i);
    if (!match) break;

    const meter = parse(match[0]);
    link.rxText = link.rxText.slice(match.index + match[0].length);

    if (meter) {
      link.address = meter.address;
      accept(meter);

      if (link.responseTimer !== null) {
        clearTimeout(link.responseTimer);
        link.responseTimer = null;
      }

      setTimeout(() => disconnectLink(link), 100);
    }
  }

  if (link.rxText.length > 64) link.rxText = link.rxText.slice(-64);
}

async function addMeter() {
  if (!navigator.bluetooth) throw new Error('此浏览器不支持 Web Bluetooth');

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'HC-08' }],
    optionalServices: [HC08_SERVICE_UUID]
  });

  createLink(device);
  $('state').textContent = '已授权';
  $('state').className = 'ok';
  $('detail').textContent = '已添加 ' + links.size + ' 个电流表，可开始读取';
}

async function restoreAuthorizedMeters() {
  if (!navigator.bluetooth?.getDevices) return;

  const devices = await navigator.bluetooth.getDevices();
  for (const device of devices) {
    if ((device.name || '').toUpperCase().includes('HC-08')) createLink(device);
  }

  if (links.size > 0) {
    $('state').textContent = '已授权';
    $('state').className = 'ok';
    $('detail').textContent = '已恢复 ' + links.size + ' 个电流表授权';
  }
}

async function requestReading(link) {
  const characteristic = await ensureConnected(link);
  const command = Uint8Array.of(0x52);

  if (characteristic.properties.writeWithoutResponse &&
      typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(command);
  } else if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(command);
  } else {
    await characteristic.writeValue(command);
  }

  if (link.responseTimer !== null) clearTimeout(link.responseTimer);
  link.responseTimer = setTimeout(() => {
    disconnectLink(link);
    $('state').textContent = '响应超时';
    $('state').className = 'error';
    $('detail').textContent = 'HC-08 在 5 秒内没有返回有效数据帧';
  }, RESPONSE_TIMEOUT_MS);
}

async function pollMeters() {
  if (links.size === 0) throw new Error('请先添加至少一个 HC-08 电流表');

  const selectedAddress = $('address').value;
  let targets = [...links.values()];

  if ($('mode').value === 'basic') {
    const knownTargets = targets.filter(
      link => link.address === null || link.address === selectedAddress
    );
    if (knownTargets.length > 0) targets = knownTargets;
  }

  const results = await Promise.allSettled(targets.map(requestReading));
  const successes = results.filter(result => result.status === 'fulfilled').length;

  if (successes === 0) {
    const failure = results.find(result => result.status === 'rejected');
    throw failure?.reason || new Error('没有可读取的电流表');
  }

  $('detail').textContent = '已向 ' + successes + ' 个电流表发送 R 命令，等待回复';
}

function stopAutoRead() {
  if (autoTimer !== null) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  $('scan').textContent = '启动自动读取';
}

function startAutoRead() {
  stopAutoRead();
  pollMeters().catch(showError);
  autoTimer = setInterval(() => pollMeters().catch(showError), AUTO_READ_PERIOD_MS);
  $('scan').textContent = '自动读取中';
}

function stop() {
  stopAutoRead();
  for (const link of links.values()) disconnectLink(link);
  $('state').textContent = '已停止';
  $('state').className = 'offline';
  $('detail').textContent = '已断开蓝牙连接，设备授权仍保留';
}

function showError(error) {
  $('state').textContent = '通信错误';
  $('state').className = 'error';
  $('detail').textContent = error.message;
}

function updateMode() {
  const autoMode = $('mode').value === 'auto';
  $('read').disabled = autoMode;
  $('scan').disabled = !autoMode;

  if (!autoMode) stopAutoRead();
  render();
}

function render() {
  const wanted = $('mode').value === 'basic'
    ? meters.get($('address').value)
    : [...meters.values()].sort((a, b) => b.time - a.time)[0];

  if (wanted) {
    const offline = $('mode').value === 'auto' &&
      Date.now() - wanted.time > AUTO_OFFLINE_MS;
    const state = statusOf(wanted, offline);

    $('current').textContent = (wanted.mA / 1000).toFixed(3) + ' A';
    $('state').textContent = state;
    $('state').className = state === 'NORMAL' ? 'ok' : state.toLowerCase();
    $('detail').textContent =
      '地址 ' + wanted.address +
      '  V1  序号 ' + wanted.seq +
      '  ' + new Date(wanted.time).toLocaleTimeString();
  } else {
    $('current').textContent = '-- A';
    $('state').textContent = links.size > 0 ? '等待读取' : '未连接';
    $('state').className = 'offline';
  }

  $('rows').innerHTML = records.slice(-100).reverse().map(record =>
    '<tr><td>' + new Date(record.time).toLocaleString() +
    '</td><td>' + record.address +
    '</td><td>' + (record.mA / 1000).toFixed(3) +
    '</td><td>' + record.state + '</td></tr>'
  ).join('');

  draw();
}

function draw() {
  const canvas = $('trend');
  const context = canvas.getContext('2d');
  const address = $('address').value;
  const points = records.filter(record => record.address === address).slice(-60);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#cad8e2';
  context.beginPath();

  for (let y = 20; y < canvas.height; y += 40) {
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
  }

  context.stroke();
  if (points.length < 2) return;

  const max = Math.max(2100, ...points.map(point => point.mA));
  context.strokeStyle = '#1261a0';
  context.lineWidth = 3;
  context.beginPath();

  points.forEach((point, index) => {
    const x = index * canvas.width / (points.length - 1);
    const y = canvas.height - 10 - point.mA * (canvas.height - 20) / max;
    if (index) context.lineTo(x, y);
    else context.moveTo(x, y);
  });

  context.stroke();
}

$('add').onclick = () => addMeter().catch(showError);
$('read').onclick = () => pollMeters().catch(showError);
$('scan').onclick = startAutoRead;
$('stop').onclick = stop;
$('mode').onchange = updateMode;
$('address').onchange = render;

$('clear').onclick = () => {
  if (confirm('清空手机中的全部记录？')) {
    records = [];
    localStorage.removeItem(KEY);
    render();
  }
};

$('csv').onclick = () => {
  const csv = 'time,address,current_A,status\n' + records.map(record =>
    new Date(record.time).toISOString() + ',' +
    record.address + ',' +
    (record.mA / 1000).toFixed(3) + ',' +
    record.state
  ).join('\n');

  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  anchor.download = 'ammeter.csv';
  anchor.click();
  URL.revokeObjectURL(anchor.href);
};

setInterval(render, 1000);
updateMode();
restoreAuthorizedMeters().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
