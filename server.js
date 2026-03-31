const express = require("express");
const cors = require("cors");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_tc3qu8agWQyJ@ep-quiet-mouse-ami2pzir-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require";

const sql = neon(DATABASE_URL);
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── PERIODOS ───

app.get("/api/periodos", async (req, res) => {
  const rows = await sql`SELECT * FROM periodos ORDER BY created_at DESC`;
  res.json(rows);
});

app.get("/api/periodos/active", async (req, res) => {
  const rows = await sql`SELECT * FROM periodos ORDER BY created_at DESC LIMIT 1`;
  res.json(rows[0] || null);
});

app.post("/api/periodos", async (req, res) => {
  const { id, nombre, fecha } = req.body;
  // Copy counts from current active period
  const active = await sql`SELECT id FROM periodos ORDER BY created_at DESC LIMIT 1`;
  const row = await sql`
    INSERT INTO periodos (id, nombre, fecha) VALUES (${id}, ${nombre}, ${fecha})
    RETURNING *`;
  if (active.length > 0) {
    await sql`
      INSERT INTO conteos (periodo_id, producto_id, almacen, barra, cocina, produccion)
      SELECT ${id}, producto_id, almacen, barra, cocina, produccion
      FROM conteos WHERE periodo_id = ${active[0].id}`;
    // Copy ventas config
    await sql`
      INSERT INTO ventas_config (periodo_id, pcts)
      SELECT ${id}, pcts FROM ventas_config WHERE periodo_id = ${active[0].id}
      ON CONFLICT DO NOTHING`;
  }
  res.json(row[0]);
});

// ─── PRODUCTOS (catalog) ───

app.get("/api/productos", async (req, res) => {
  const rows = await sql`SELECT * FROM productos ORDER BY categoria, nombre`;
  res.json(rows);
});

app.post("/api/productos", async (req, res) => {
  const { id, nombre, categoria, precio, presentacion, unidad } = req.body;
  const row = await sql`
    INSERT INTO productos (id, nombre, categoria, precio, presentacion, unidad)
    VALUES (${id}, ${nombre}, ${categoria}, ${precio || 0}, ${presentacion || ""}, ${unidad || ""})
    RETURNING *`;
  res.json(row[0]);
});

app.put("/api/productos/:id", async (req, res) => {
  const { nombre, categoria, precio, presentacion, unidad } = req.body;
  const row = await sql`
    UPDATE productos SET nombre=${nombre}, categoria=${categoria}, precio=${precio || 0},
    presentacion=${presentacion || ""}, unidad=${unidad || ""}
    WHERE id=${req.params.id} RETURNING *`;
  res.json(row[0]);
});

// ─── CONTEOS (inventory counts) ───

app.get("/api/conteos/:periodoId", async (req, res) => {
  const rows = await sql`
    SELECT c.*, p.nombre, p.categoria, p.precio, p.presentacion, p.unidad
    FROM conteos c JOIN productos p ON c.producto_id = p.id
    WHERE c.periodo_id = ${req.params.periodoId}`;
  res.json(rows);
});

app.put("/api/conteos/:periodoId/:productoId", async (req, res) => {
  const { almacen, barra, cocina, produccion } = req.body;
  const row = await sql`
    INSERT INTO conteos (periodo_id, producto_id, almacen, barra, cocina, produccion)
    VALUES (${req.params.periodoId}, ${req.params.productoId},
            ${almacen || 0}, ${barra || 0}, ${cocina || 0}, ${produccion || 0})
    ON CONFLICT (periodo_id, producto_id) DO UPDATE SET
      almacen = EXCLUDED.almacen, barra = EXCLUDED.barra,
      cocina = EXCLUDED.cocina, produccion = EXCLUDED.produccion
    RETURNING *`;
  res.json(row[0]);
});

// ─── TOTALS (aggregated) ───

app.get("/api/totals/:periodoId", async (req, res) => {
  const rows = await sql`
    SELECT p.categoria,
           SUM((c.almacen + c.barra + c.cocina + c.produccion) * p.precio) as total
    FROM conteos c JOIN productos p ON c.producto_id = p.id
    WHERE c.periodo_id = ${req.params.periodoId}
    GROUP BY p.categoria`;
  const result = { _t: 0 };
  for (const r of rows) {
    result[r.categoria] = parseFloat(r.total);
    result._t += parseFloat(r.total);
  }
  res.json(result);
});

// ─── COMPRAS ───

app.get("/api/compras/:periodoId", async (req, res) => {
  const rows = await sql`
    SELECT * FROM compras WHERE periodo_id = ${req.params.periodoId}
    ORDER BY created_at`;
  res.json(rows);
});

app.post("/api/compras", async (req, res) => {
  const { periodo_id, categoria, monto, descripcion, fecha } = req.body;
  const row = await sql`
    INSERT INTO compras (periodo_id, categoria, monto, descripcion, fecha)
    VALUES (${periodo_id}, ${categoria}, ${monto}, ${descripcion || ""}, ${fecha})
    RETURNING *`;
  res.json(row[0]);
});

app.delete("/api/compras/:id", async (req, res) => {
  await sql`DELETE FROM compras WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

// ─── VENTAS DIARIAS ───

app.get("/api/ventas/:periodoId", async (req, res) => {
  const rows = await sql`
    SELECT * FROM ventas_diarias WHERE periodo_id = ${req.params.periodoId}
    ORDER BY fecha`;
  res.json(rows);
});

app.post("/api/ventas", async (req, res) => {
  const { periodo_id, fecha, monto, nota } = req.body;
  const row = await sql`
    INSERT INTO ventas_diarias (periodo_id, fecha, monto, nota)
    VALUES (${periodo_id}, ${fecha}, ${monto}, ${nota || ""})
    ON CONFLICT (periodo_id, fecha) DO UPDATE SET monto = EXCLUDED.monto, nota = EXCLUDED.nota
    RETURNING *`;
  res.json(row[0]);
});

app.delete("/api/ventas/:id", async (req, res) => {
  await sql`DELETE FROM ventas_diarias WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

// ─── VENTAS CONFIG (% costos) ───

app.get("/api/ventas-config/:periodoId", async (req, res) => {
  const rows = await sql`SELECT * FROM ventas_config WHERE periodo_id = ${req.params.periodoId}`;
  res.json(rows[0] || { periodo_id: req.params.periodoId, pcts: {} });
});

app.put("/api/ventas-config/:periodoId", async (req, res) => {
  const { pcts } = req.body;
  const row = await sql`
    INSERT INTO ventas_config (periodo_id, pcts) VALUES (${req.params.periodoId}, ${JSON.stringify(pcts)})
    ON CONFLICT (periodo_id) DO UPDATE SET pcts = ${JSON.stringify(pcts)}
    RETURNING *`;
  res.json(row[0]);
});

// ─── FULL STATE (for initial load — single request) ───

app.get("/api/state/:periodoId", async (req, res) => {
  const pid = req.params.periodoId;
  const [periodos, productos, conteos, compras, ventas, ventasConfig] =
    await Promise.all([
      sql`SELECT * FROM periodos ORDER BY created_at DESC`,
      sql`SELECT * FROM productos ORDER BY categoria, nombre`,
      sql`SELECT * FROM conteos WHERE periodo_id = ${pid}`,
      sql`SELECT * FROM compras WHERE periodo_id = ${pid} ORDER BY created_at`,
      sql`SELECT * FROM ventas_diarias WHERE periodo_id = ${pid} ORDER BY fecha`,
      sql`SELECT * FROM ventas_config WHERE periodo_id = ${pid}`,
    ]);
  res.json({
    periodos,
    productos,
    conteos,
    compras,
    ventas,
    ventasConfig: ventasConfig[0] || { pcts: {} },
  });
});

// Serve index.html for all non-API routes
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
