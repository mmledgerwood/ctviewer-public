// Shared: replaces a Niivue instance's native (single-color, thick) 3D crosshair
// with three thin GL_LINES, one per world axis, colored to match the 2D panel
// convention (axial=red, coronal=green, sagittal=blue). Used by both the main
// page and the pop-out window so their 3D crosshairs always look identical.
export function patchCrosshair3DColored(instance) {
  const gl = instance.gl;
  const AXIS_COLORS = [
    [0.231, 0.51, 0.965], // X axis (left-right)        -> sagittal blue  #3b82f6
    [0.204, 0.78, 0.349],  // Y axis (anterior-posterior) -> coronal green #34c759
    [1.0, 0.231, 0.188],   // Z axis (superior-inferior)  -> axial red     #ff3b30
  ];
  let buf = null; // { vao, vertexBuffer, mm }

  function buildLines(mm, mn, mx) {
    if (buf) {
      gl.deleteBuffer(buf.vertexBuffer);
      gl.deleteVertexArray(buf.vao);
    }
    const verts = new Float32Array([
      mn[0], mm[1], mm[2], mx[0], mm[1], mm[2],
      mm[0], mn[1], mm[2], mm[0], mx[1], mm[2],
      mm[0], mm[1], mn[2], mm[0], mm[1], mx[2],
    ]);
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    buf = { vao, vertexBuffer, mm };
  }

  instance.drawCrosshairs3D = function (isDepthTest = true, alpha = 1, mvpMtx = null, is2DView = false, isSliceMM = true) {
    if (is2DView || !this.opts.show3Dcrosshair || !this.volumes.length) return;
    const mm = this.frac2mm(this.scene.crosshairPos, 0, isSliceMM);
    const [mn, mx] = this.sceneExtentsMinMax(isSliceMM);
    if (!buf || buf.mm[0] !== mm[0] || buf.mm[1] !== mm[1] || buf.mm[2] !== mm[2]) {
      buildLines(mm, mn, mx);
    }
    if (!this.surfaceShader) return;
    const shader = this.surfaceShader;
    shader.use(gl);
    if (mvpMtx == null) {
      [mvpMtx] = this.calculateMvpMatrix(null, void 0, this.scene.renderAzimuth, this.scene.renderElevation);
    }
    gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMtx);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    if (isDepthTest) {
      gl.disable(gl.BLEND);
      gl.depthFunc(gl.LEQUAL);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.ALWAYS);
    }
    gl.bindVertexArray(buf.vao);
    for (let i = 0; i < 3; i++) {
      gl.uniform4fv(shader.uniforms.surfaceColor, [...AXIS_COLORS[i], alpha]);
      gl.drawArrays(gl.LINES, i * 2, 2);
    }
    gl.bindVertexArray(this.unusedVAO);
  };
}
