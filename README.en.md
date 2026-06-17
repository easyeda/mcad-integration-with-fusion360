[English](#) | [简体中文](README.md)

# Fusion360 MCAD Integration — EasyEDA Pro Extension

Real-time collaboration between EasyEDA Pro and Fusion360 via WebSocket + HTTP. Supports model export, bidirectional position sync, cross-probe, and deletion sync.

## Features

| Feature | Description |
|---|---|
| 3D Model Export | Transfer PCB STEP model to Fusion360 in chunks, supports large files |
| Download Script | One-click save Fusion360 Add-In script to local disk |
| Bidirectional Position Sync | Drag component in EDA → Fusion360 follows, and vice versa |
| Cross-Probe | Click a component on one side, the other side auto-focuses |
| Deletion Sync | Delete component in EDA, Fusion360 removes it simultaneously |

***

## Requirements

| Item | Requirement |
|---|---|
| EasyEDA Pro | ≥ 3.0 |
| Fusion360 | Installed and runnable |
| Python | Fusion360 built-in Python environment |
| Network | Localhost available |

***

## Installation

### Step 1: Install EDA Extension

1. Open **EasyEDA Pro**
2. After installation, find **Fusion360 MCAD Integration** in the extension list and confirm it is enabled
3. **Enable external interaction permission**: Go to **Extensions** → **Extension Settings** → Enable **External Interaction** permission (required for WebSocket communication)

### Step 2: Install Fusion360 Script

1. Download the script
   (The script file can also be saved locally via EDA menu **Fusion360 MCAD Integration** → **Download Script**)
   ![](images/下载脚本.png)
2. Open **Fusion360** and create a new document
   ![](images/fusion打开.gif)
3. Create a new add-in module
   ![](images/创建脚本.gif)
4. Open the script file location, replace the script content with the downloaded script file. Note that the script name must match the one used during creation.
   ![](images/6.png)
   ![](images/7.png)
5. Click Run. Note: you must run the module, not the script file.

   ![](images/8.png)
6. **Verify successful startup**: You should see the following in Fusion360's text command window:

```
[EasyEDA] CustomEvent registered
[EasyEDA] Add-in started ✅
[EasyEDA] Starting WebSocket server on ws://0.0.0.0:8767
```

## Usage Guide

### 1. Export 3D Model to Fusion360

1. Make sure the Fusion360 Add-In script is running
2. **Create or open a component design document in Fusion360**

   ![](images/fusion打开.gif)

   If the script is already running, just click the export button — a new document will be created automatically.
3. Open a PCB design file in EDA, enter the **PCB Editor**
4. Click menu **Fusion360 MCAD Integration** → **Export 3D to Fusion360**

![](images/1.png)\
5\. Automatically connects to Fusion360, retrieves the STEP file, and uploads it in chunks.

![](images/2.png)

![](images/11.png)

### 2. Enable Bidirectional Interaction

After exporting the model, you can enable bidirectional interaction for real-time sync:

1. Click menu **Fusion360 MCAD Integration** → **Enable Bidirectional**
   ![](images/3.png)
2. EDA will automatically map component designators to Fusion360 3D objects (build\_mapping)
3. After mapping is successful, you can:
   - **Drag a component in EDA** → The 3D model in Fusion360 follows in real-time
   - **Drag an object in Fusion360** → The component in EDA moves synchronously (via HTTP polling for position changes)
   - **Click a component in EDA** → Fusion360 auto-selects and focuses (flashing highlight)
   - **Click an object in Fusion360** → EDA auto-navigates to the corresponding component

> **Known Limitation:**
> The mapping is one-to-one. Opening multiple pages will cause mapping conflicts. Please operate on a single page.


### 3. Stop Bidirectional Interaction

1. Click menu **Fusion360 MCAD Integration** → **Disable Bidirectional**

![](images/4.png)

2. All mappings and listeners will be cleared.

### 4. Connection Management

| Menu Option | Function |
|---|---|
| Export 3D to Fusion360 | Auto-connect + chunked upload + import |
| Enable Bidirectional | Enable real-time bidirectional sync |
| Disable Bidirectional | Stop sync and clear mappings |
| Disconnect Fusion360 | Disconnect WebSocket connection |
| Download Script | Save Fusion360 script |

***

## Technical Details

### Communication Architecture

```
EDA ←— WebSocket:8767 —→ Fusion (Command channel: upload/mapping/position update/cross-probe)
EDA ←— HTTP:8768/poll ←— Fusion (Status channel: selection detection/position changes)
```

| Direction | Protocol | Description |
|---|---|---|
| EDA → Fusion | WebSocket | File upload, designator mapping, position sync, cross-probe, delete, rename |
| Fusion → EDA | HTTP Polling | Detect selection state and position changes every 2 seconds, return to EDA |

### Key Technical Decisions

| Item | Solution | Reason |
|---|---|---|
| WebSocket Implementation | Pure Python | Fusion360 environment cannot install third-party libraries |
| HTTP Server | Python built-in `http.server` | Polling for Fusion state changes |
| STEP Import | `executeTextCommand('Translator.Import')` | Can be safely called from background thread, bypasses DataFile limitations |
| Selection/Movement Detection | HTTP polling `ui.activeSelections` | Fusion360 API events (`activeSelectionChanged`, `selectionEvent`) do not respond to component selection in this version |
| Position Change Threshold | Position 0.1mm, Rotation 0.5° | Filter floating-point noise, avoid feedback loops |

### Thread Safety

Fusion360 API requires all document operations to run on the main thread, but WebSocket/HTTP runs on background threads.

- **Read operations** (selection detection, position reading): Can be called directly from HTTP/WS background threads, works but not fully stable
- **Write operations** (position update, cross-probe, delete): Commands received via WS are called directly
- **`executeTextCommand`**: Can be safely called from background thread (Fusion executes internally on main thread)
- Polling interval of 2 seconds reduces crash probability caused by thread contention

## FAQ

### Failed to connect to Fusion360

Check in order:

1. **Is Fusion360 running** and the Add-In script is active
2. **Is port 8767/8768 occupied** — Close Fusion360 and retry
3. **External interaction permission** — Is it enabled in EDA extension settings
4. **Firewall** — Check if Windows firewall is blocking the port

### "Design OK" after import but no model visible

Make sure a **component design** document is open or created before import. `Translator.Import` imports the STEP into the currently active document.

### Fusion360 freezes when importing large files

Fusion360's STEP import is a synchronous operation. The UI may become unresponsive during large file imports. It recovers automatically after import completes. The code uses `time.sleep(3)` to wait for import completion.

### Fusion360 crashes after bidirectional interaction runs for a while

This is a Fusion360 API thread safety limitation. Background threads (HTTP/WS) reading Fusion API may compete with the main thread, causing crashes. Reducing polling frequency can help (currently 2 seconds).

### Selecting a component in Fusion360 has no response in EDA

1. Confirm bidirectional interaction is enabled (log should show `Monitor enabled`)
2. Polling interval is 2 seconds, wait 1-2 seconds after selection
3. Check if designator mapping was correctly established (log should show `Mapping: X / Y matched`)

***

## Project Structure

```
pcb-export-to-fusion/
├── src/
│   └── index.ts                         # EDA extension main logic (TypeScript)
├── script/
│   ├── Interactive-with-fusion.py       # Python script
├── config/
│   ├── esbuild.common.ts                # Build configuration
│   └── esbuild.prod.ts
├── build/
│   ├── packaged.ts                      # Packaging script
│   └── dist/
├── locales/
│   ├── zh-Hans.json                     # Chinese translations
│   └── en.json                          # English translations
├── images/
│   └── logo.png                         # Extension icon
├── extension.json                       # Extension manifest
├── package.json
└── tsconfig.json
```
