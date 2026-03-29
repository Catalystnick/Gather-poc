# 2D Migration — Visual Diagram

```mermaid
flowchart TD
    subgraph INTENDED["✅ Intended: Proper 2D Setup"]
        direction TB
        CAM2["Camera at (0, 0, 100)\nlooking at XY plane"]
        WORLD2["World lives on XY plane\nX = east/west\nY = north/south"]
        SORT2["Y-sort: larger Y = further north\nsmaller Y = further south = on top\nrenderOrder = BASE - worldY * scale"]
        CAM2 --> WORLD2 --> SORT2
    end

    subgraph ACTUAL["❌ Actual: 3D Template Leftovers"]
        direction TB
        CAM3["Camera at (0, 20, 0)\nlooking DOWN at XZ plane"]
        WORLD3["World lives on XZ plane\nX = east/west\nZ = north/south\nY = unused height axis"]
        SORT3["'Y-sort' actually sorts by Z\nrenderOrder = BASE + worldZ * scale\nconfusing and unintuitive"]
        CAM3 --> WORLD3 --> SORT3
    end

    subgraph MISTAKE["⚠️ Where the pivot went wrong"]
        direction TB
        STEP1["Asked for orthographic camera"]
        STEP2["AI switched PerspectiveCamera\n→ OrthographicCamera ✓"]
        STEP3["Camera moved to (0, 20, 0)\nstill looking down at XZ\n— axis never reconsidered ✗"]
        STEP4["Looked correct on screen\n(XZ and XY look identical\nfrom top-down view)"]
        STEP5["Bug only surfaces later\nwhen Y-sort is implemented\nand 'sort by Y' doesn't work"]
        STEP1 --> STEP2 --> STEP3 --> STEP4 --> STEP5
    end

    MISTAKE --> ACTUAL
    ACTUAL -->|"migration plan fixes this"| INTENDED
```

> **Key insight:** The bug was silent. XZ and XY look pixel-identical through a top-down
> orthographic camera, so there was no visual feedback that anything was wrong. It only
> became painful when Y-sort was implemented and "sort by Y" didn't work — because the
> world was built on Z, not Y.
