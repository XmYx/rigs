// Sketch canvas for image-to-image: brush, eraser, undo, clear. The canvas keeps its own pixel size
// (768×768) and is shown scaled; pointer positions are mapped back with canvasPoint().

/** A pointer position in page pixels → canvas pixels, for a canvas drawn into `rect`. */
export function canvasPoint(rect, clientX, clientY, width, height) {
  return {
    x: ((clientX - rect.left) / (rect.width || 1)) * width,
    y: ((clientY - rect.top) / (rect.height || 1)) * height,
  };
}

export function createSketch(canvas, { onChange = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const undoStack = [];
  let color = '#1f2937';
  let size = 14;
  let eraser = false;
  let drawing = null;
  let blank = true;

  const fill = () => { ctx.save(); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore(); };
  fill();

  const point = (e) => canvasPoint(canvas.getBoundingClientRect(), e.clientX, e.clientY, canvas.width, canvas.height);
  const scale = () => canvas.width / (canvas.getBoundingClientRect().width || canvas.width);

  function stroke(from, to) {
    ctx.strokeStyle = eraser ? '#ffffff' : color;
    ctx.lineWidth = size * scale();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.length > 25) undoStack.shift();
    drawing = point(e);
    stroke(drawing, { x: drawing.x + 0.01, y: drawing.y });
    blank = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e);
    stroke(drawing, p);
    drawing = p;
  });
  const up = () => { if (!drawing) return; drawing = null; onChange(); };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    setColor(c) { color = c; eraser = false; },
    setSize(s) { size = Number(s) || size; },
    setEraser(on) { eraser = !!on; },
    get eraser() { return eraser; },
    isBlank: () => blank,
    undo() {
      const prev = undoStack.pop();
      if (!prev) return;
      ctx.putImageData(prev, 0, 0);
      if (!undoStack.length) blank = true;
      onChange();
    },
    clear() {
      undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      fill();
      blank = true;
      onChange();
    },
    /** Draw an image into the canvas (fit and centred) so it can be painted over. */
    load(img) {
      undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      fill();
      const k = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      blank = false;
      onChange();
    },
    toBlob: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
  };
}
