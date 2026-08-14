from __future__ import annotations

import gzip
import json
import struct
from dataclasses import dataclass
from typing import Any


ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
ASR_RESOURCE_ID = "volc.seedasr.sauc.duration"

MSG_FULL_CLIENT_REQUEST = 0x1
MSG_AUDIO_ONLY_REQUEST = 0x2
MSG_FULL_SERVER_RESPONSE = 0x9
MSG_ERROR = 0xF
FLAG_NO_SEQUENCE = 0x0
FLAG_POS_SEQUENCE = 0x1
FLAG_FINAL_NO_SEQUENCE = 0x2
FLAG_NEG_SEQUENCE = 0x3
SERIALIZATION_NONE = 0x0
SERIALIZATION_JSON = 0x1
COMPRESSION_NONE = 0x0
COMPRESSION_GZIP = 0x1


def protocol_header(
    message_type: int,
    flags: int,
    serialization: int,
    compression: int,
) -> bytes:
    return bytes(
        [
            0x11,
            (message_type << 4) | flags,
            (serialization << 4) | compression,
            0x00,
        ]
    )


def full_client_request() -> bytes:
    payload = {
        "user": {"uid": "hotel-scheduler-web"},
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
        },
        "request": {
            "model_name": "bigmodel",
            "enable_nonstream": True,
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
            "result_type": "full",
            "end_window_size": 800,
        },
    }
    compressed = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return (
        protocol_header(
            MSG_FULL_CLIENT_REQUEST,
            FLAG_NO_SEQUENCE,
            SERIALIZATION_JSON,
            COMPRESSION_GZIP,
        )
        + struct.pack(">I", len(compressed))
        + compressed
    )


def audio_request(audio: bytes, final: bool = False) -> bytes:
    compressed = gzip.compress(audio)
    return (
        protocol_header(
            MSG_AUDIO_ONLY_REQUEST,
            FLAG_FINAL_NO_SEQUENCE if final else FLAG_NO_SEQUENCE,
            SERIALIZATION_NONE,
            COMPRESSION_GZIP,
        )
        + struct.pack(">I", len(compressed))
        + compressed
    )


@dataclass(slots=True)
class ServerFrame:
    message_type: int
    flags: int
    payload: bytes
    error_code: int = 0

    @property
    def final(self) -> bool:
        return self.flags in {FLAG_FINAL_NO_SEQUENCE, FLAG_NEG_SEQUENCE}


def parse_server_frame(data: bytes) -> ServerFrame:
    if len(data) < 4:
        raise ValueError("语音服务返回了不完整的数据")
    header_size = (data[0] & 0x0F) * 4
    message_type = (data[1] >> 4) & 0x0F
    flags = data[1] & 0x0F
    compression = data[2] & 0x0F
    offset = header_size
    error_code = 0
    if message_type == MSG_ERROR:
        if len(data) < offset + 8:
            raise ValueError("语音服务返回了不完整的错误信息")
        error_code = struct.unpack(">I", data[offset : offset + 4])[0]
        offset += 4
    elif flags in {FLAG_POS_SEQUENCE, FLAG_NEG_SEQUENCE}:
        if len(data) < offset + 4:
            raise ValueError("语音服务返回了不完整的序号")
        offset += 4
    if len(data) < offset + 4:
        raise ValueError("语音服务返回了不完整的内容")
    size = struct.unpack(">I", data[offset : offset + 4])[0]
    payload = data[offset + 4 : offset + 4 + size]
    if compression == COMPRESSION_GZIP:
        payload = gzip.decompress(payload)
    return ServerFrame(message_type, flags, payload, error_code)


def frame_payload(frame: ServerFrame) -> dict[str, Any]:
    if not frame.payload:
        return {}
    text = frame.payload.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"message": text}


def transcript_from_payload(payload: dict[str, Any]) -> str:
    result = payload.get("result")
    if not isinstance(result, dict):
        return str(payload.get("text") or "").strip()
    text = str(result.get("text") or "").strip()
    if text:
        return text
    utterances = result.get("utterances")
    if not isinstance(utterances, list):
        return ""
    return "".join(
        str(item.get("text") or "")
        for item in utterances
        if isinstance(item, dict)
    ).strip()
