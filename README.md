# pi-agnes

Pi extension for [Agnes AI](https://agnes-ai.com), with dynamic model discovery and support for both Agnes endpoints.

## Install

```bash
pi install npm:pi-agnes
```

Or install from git:

```bash
pi install git:github.com/pgciq/pi-agnes
```

## Configuration

Set the API key for the endpoint you want to use:

| Provider | Endpoint | Environment variable |
|---|---|---|
| `agnes` | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

## Model discovery (non-blocking)

`pi-agnes` registers a **seed** model catalog synchronously at load (so pi starts instantly) and refreshes it from `/v1/models` **in the background** via pi's `refreshModels` callback — it never blocks startup on the network.

- The seed list is always available immediately, even offline or without `AGNES_API_KEY` / `AGNES_CN_API_KEY`.
- A successful background refresh replaces the seed list and is persisted to pi's provider cache, so it survives restarts and offline starts.
- Every network call is bounded by a timeout and degrades to the seed list on any failure.

## Usage

```bash
pi --model agnes/agnes-2.5-flash "你好"
pi --model agnes-cn/agnes-2.5-pro "你好"
```
