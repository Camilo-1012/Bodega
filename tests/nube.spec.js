// Sincronización entre dos celulares (Supabase simulado): lecturas compartidas, trabajo sin señal, conflictos y permisos.
const { test, expect, devices } = require("@playwright/test");
const A = require("./ayuda"), N = require("./nube");

async function celular(browser, nube, usuario){
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: "http://localhost:8791" });
  await N.conectarNube(context, nube);
  const page = await context.newPage();
  const errs = A.vigilarErrores(page);
  await A.entrar(page, usuario, A.PIN, true);
  return { context, page, errs };
}
async function conectar(page, email, pass){
  await A.menu(page, "btnTeam");
  await page.fill("#tmEmail", email); await page.fill("#tmPass", pass); await page.click("#tmConnect");
  await expect(page.locator("#tmOn")).toBeVisible();
  await page.locator("#dlgTeam .dlgHead button").click();
}
const sincronizar = page => page.evaluate(() => syncNow(false));

test("dos celulares: lo que lee uno lo ve el otro, y un conflicto sin señal se detecta y se resuelve", async ({ browser }) => {
  const nube = N.crearNube();
  const a = await celular(browser, nube, "Camilo"), b = await celular(browser, nube, "Ana");
  await conectar(a.page, "admin@b.co", "clave1");
  await A.agregarRep(a.page, "Jairo"); await A.agregarRep(a.page, "Pedro");
  await A.nuevoLote(a.page, "Xcargo", "Lote 1");
  await a.page.click("#recScan");
  for(const g of ["NUBE000001", "NUBE000002"]) expect((await A.leer(a.page, g)).tipo).toBe("ok");
  await a.page.click("#scClose");
  await sincronizar(a.page);
  expect(nube.eventos.length).toBe(5);   // 2 repartidores + lote + 2 recibidos

  // El celular B se conecta y baja todo.
  await conectar(b.page, "despacho@b.co", "clave2");
  await expect(b.page.locator("#stBodega")).toHaveText("2");
  await b.page.click('nav.tabs button[data-v="vDespachar"]');
  await expect(b.page.locator("#desReps button")).toHaveCount(2);

  // Sin señal en los dos: A le da NUBE000002 a Jairo y B se la da a Pedro.
  nube.caida = true;
  await a.page.click('nav.tabs button[data-v="vDespachar"]');
  await a.page.locator("#desReps button", { hasText: "Jairo" }).click();
  await a.page.click("#desScan"); expect((await A.leer(a.page, "NUBE000002")).txt).toBe("Para Jairo"); await a.page.click("#scClose");
  await b.page.locator("#desReps button", { hasText: "Pedro" }).click();
  await b.page.click("#desScan"); expect((await A.leer(b.page, "NUBE000002")).txt).toBe("Para Pedro"); await b.page.click("#scClose");
  await sincronizar(a.page);
  await expect(a.page.locator("#syncChip")).toContainText("1 sin subir");
  nube.caida = false;
  await sincronizar(a.page); await sincronizar(b.page); await sincronizar(a.page);
  for(const c of [a, b]){
    await c.page.click('nav.tabs button[data-v="vConsultar"]');
    await expect(c.page.locator("#conNConf")).toHaveText("1");
  }
  // Se resuelve en A: la tiene Pedro. B se entera al sincronizar.
  await a.page.click("#conConflictos");
  await a.page.locator("#conLista li[data-guia]").first().click();
  await a.page.locator("#conResolver button", { hasText: "Pedro" }).click();
  await expect(a.page.locator("#conNConf")).toBeHidden();
  await sincronizar(a.page); await sincronizar(b.page);
  await expect(b.page.locator("#conNConf")).toBeHidden();
  const p = await b.page.evaluate(() => ({ e: paq("NUBE000002").estado, r: repNombre(paq("NUBE000002").rid) }));
  expect(p).toEqual({ e: "RUTA", r: "Pedro" });
  expect(a.errs).toEqual([]); expect(b.errs).toEqual([]);
  await a.context.close(); await b.context.close();
});

test("una cuenta sin rol de administrador no puede crear repartidores en la nube (el resto sí sube)", async ({ browser }) => {
  const nube = N.crearNube();
  const b = await celular(browser, nube, "Ana");
  await conectar(b.page, "despacho@b.co", "clave2");
  await A.agregarRep(b.page, "Intruso");
  await A.nuevoLote(b.page);
  await b.page.click("#recEscribir"); await A.responder(b.page, { g: "PERM000001" });
  await sincronizar(b.page);
  expect(nube.eventos.map(e => e.tipo).sort()).toEqual(["LOTE", "RECIBIDO"]);
  await expect(b.page.locator("#syncChip")).toContainText("Nube: revisar");
  await expect(b.page.locator("#syncChip")).not.toContainText("sin subir");   // el rechazado no se reintenta sin fin
  expect(b.errs).toEqual([]);
  await b.context.close();
});

test("contraseña incorrecta o cuenta no autorizada: no queda conectada", async ({ browser }) => {
  const nube = N.crearNube();
  nube.cuentas["otro@b.co"] = { uid: "u-otro", pass: "x", nombre: "", rol: "" };
  const b = await celular(browser, nube, "Ana");
  await A.menu(b.page, "btnTeam");
  await b.page.fill("#tmEmail", "despacho@b.co"); await b.page.fill("#tmPass", "mala"); await b.page.click("#tmConnect");
  await expect(b.page.locator("#tmErr")).toHaveText("Correo o contraseña incorrectos.");
  await b.page.route(/bodega_miembros/, r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await b.page.fill("#tmPass", "clave2"); await b.page.click("#tmConnect");
  await expect(b.page.locator("#tmErr")).toContainText("no está autorizada");
  await expect(b.page.locator("#tmOff")).toBeVisible();
  expect(b.errs).toEqual([]);
  await b.context.close();
});
