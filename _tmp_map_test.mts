
import assert from "node:assert/strict";
import { getRoomCanvasSize, adaptCabinetsToCanvas } from "./client/src/components/LibraryMap2D.tsx";

const room = { length_m: 7.62, width_m: 4.65, canvas_w: 760, canvas_h: 472 };
const size = getRoomCanvasSize(room);
assert.equal(size.canvasW, 760);
assert.equal(size.canvasH, 472);

// Stale pixel width=45, height=45 from old bug, while width_cm=23.5, depth_cm=57
const cabs = [{ id: 1, x: 650, y: 300, width: 45, height: 45, width_cm: 23.5, depth_cm: 57, rotation: 90 }];
const adapted = adaptCabinetsToCanvas(cabs, 760, 472, size.canvasW, size.canvasH, true, size.pxPerCm);
const expectedW = Math.round(23.5 * size.pxPerCm * 10) / 10;
const expectedH = Math.round(57 * size.pxPerCm * 10) / 10;
assert.equal(adapted[0].width, expectedW);
assert.equal(adapted[0].height, expectedH);
assert.ok(adapted[0].width < 25, "Small decimal cabinet 23.5cm must not be clamped to 40px");

console.log("MAP_ADAPT_TESTS_PASSED", { expectedW, expectedH, adapted: adapted[0] });
