"""Standard Bluetooth Heart Rate Service (0x180D) helpers.

WHOOP's Heart Rate Broadcast, chest straps, and most watches in "broadcast" mode all
send the same Heart Rate Measurement characteristic (0x2A37), about once per second.
Kept free of the bleak import so it can be unit-tested anywhere.
"""

HR_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb"


def parse_hr_measurement(data: bytes) -> dict:
    """Decode one 0x2A37 notification into bpm, RR intervals (ms) and sensor contact."""
    if len(data) < 2:
        raise ValueError("Heart rate packet too short")
    flags = data[0]
    i = 1
    if flags & 0x01:  # heart rate is uint16
        bpm = int.from_bytes(data[i : i + 2], "little")
        i += 2
    else:  # heart rate is uint8
        bpm = data[i]
        i += 1
    contact = bool(flags & 0x02) if flags & 0x04 else None
    if flags & 0x08:  # energy expended field present, skip it
        i += 2
    rr_ms: list[float] = []
    if flags & 0x10:  # RR intervals in 1/1024 s
        while i + 1 < len(data):
            rr_ms.append(round(int.from_bytes(data[i : i + 2], "little") * 1000 / 1024, 1))
            i += 2
    return {"bpm": bpm, "rr_ms": rr_ms, "sensor_contact": contact}
