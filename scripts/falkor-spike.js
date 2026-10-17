#!/usr/bin/env node
// Stage 0 spike: verifies every FalkorDB assumption the memory graph depends on.
const { FalkorDB, ConstraintType, EntityType } = require("falkordb");

const URL = process.env.RELAY_FALKOR_URL || "falkor://localhost:6379";
const results = [];

async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: String(err.message || err) });
  }
}

async function main() {
  const db = await FalkorDB.connect({ url: URL });
  const g = db.selectGraph(`relay_spike_${Date.now()}`);

  await check("connect + result shape", async () => {
    const r = await g.query("CREATE (a:File {key:'a', path:'A'}) RETURN a.key AS k, 1 AS n");
    return { keys: Object.keys(r), data: r.data };
  });

  await check("roQuery", async () => {
    const r = await g.roQuery("MATCH (f:File) RETURN count(f) AS c");
    return r.data;
  });

  await check("roQuery rejects writes", async () => {
    try {
      await g.roQuery("CREATE (:X)");
      throw new Error("write allowed in roQuery");
    } catch (err) {
      if (String(err.message).includes("write allowed")) throw err;
      return "rejected: " + String(err.message).slice(0, 80);
    }
  });

  await check("params", async () => {
    const r = await g.query("MATCH (f:File {key:$k}) RETURN f.path AS p", { params: { k: "a" } });
    return r.data;
  });

  await check("range index (DDL)", async () => {
    await g.query("CREATE INDEX FOR (n:File) ON (n.key)");
    await g.query("CREATE INDEX FOR (n:Edit) ON (n.ts)");
    return "ok";
  });

  await check("duplicate index errors?", async () => {
    try {
      await g.query("CREATE INDEX FOR (n:File) ON (n.key)");
      return "no error on duplicate";
    } catch (err) {
      return "errors: " + String(err.message).slice(0, 80);
    }
  });

  await check("db.indexes() shape", async () => {
    const r = await g.roQuery("CALL db.indexes() YIELD label, properties, types RETURN label, properties, types");
    return r.data;
  });

  await check("unique constraint via client", async () => {
    await g.constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, "File", "key");
    await new Promise((r) => setTimeout(r, 300));
    const r = await g.roQuery("CALL db.constraints()");
    return r.data;
  });

  await check("fulltext index + query", async () => {
    await g.query("CREATE FULLTEXT INDEX FOR (n:Turn) ON (n.text)");
    await g.query("CREATE (:Turn {key:'t1', text:'switch login to JWT tokens'}), (:Turn {key:'t2', text:'fix the css'})");
    await new Promise((r) => setTimeout(r, 300));
    const r = await g.roQuery(
      "CALL db.idx.fulltext.queryNodes('Turn', $q) YIELD node, score RETURN node.key AS k, score",
      { params: { q: "JWT" } }
    );
    return r.data;
  });

  await check("FOREACH/CASE conditional MERGE", async () => {
    const r = await g.query(
      `MATCH (f:File {key:'a'})
       OPTIONAL MATCH (t:Turn {key:$tk})
       FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | MERGE (f)-[:PROMPTED_BY]->(t))
       WITH f
       OPTIONAL MATCH (m:Turn {key:'missing'})
       FOREACH (_ IN CASE WHEN m IS NULL THEN [] ELSE [1] END | MERGE (f)-[:PROMPTED_BY]->(m))
       RETURN 1 AS ok`,
      { params: { tk: "t1" } }
    );
    const c = await g.roQuery("MATCH ()-[r:PROMPTED_BY]->() RETURN count(r) AS c");
    return { ran: r.data, edges: c.data };
  });

  await check("ON CREATE SET on another node", async () => {
    await g.query("MERGE (f:File {key:'cnt'}) ON CREATE SET f.editCount = 0");
    const q = `MATCH (f:File {key:'cnt'})
               MERGE (e:Edit {key:$ek}) ON CREATE SET e.ts = 1, f.editCount = f.editCount + 1
               RETURN f.editCount AS c`;
    await g.query(q, { params: { ek: "e1" } });
    await g.query(q, { params: { ek: "e1" } });
    const r = await g.query(q, { params: { ek: "e2" } });
    return { expected: 2, got: r.data };
  });

  await check("CASE max-update idiom", async () => {
    await g.query("MERGE (f:File {key:'m'}) SET f.lastAt = CASE WHEN f.lastAt IS NULL OR $t > f.lastAt THEN $t ELSE f.lastAt END", { params: { t: 5 } });
    await g.query("MERGE (f:File {key:'m'}) SET f.lastAt = CASE WHEN f.lastAt IS NULL OR $t > f.lastAt THEN $t ELSE f.lastAt END", { params: { t: 3 } });
    const r = await g.roQuery("MATCH (f:File {key:'m'}) RETURN f.lastAt AS v");
    return { expected: 5, got: r.data };
  });

  await check("MERGE with null key errors?", async () => {
    try {
      await g.query("MERGE (f:File {key:$k})", { params: { k: null } });
      return "no error";
    } catch (err) {
      return "errors: " + String(err.message).slice(0, 80);
    }
  });

  await check("string array property", async () => {
    await g.query("MERGE (a:Agent {key:'x'}) SET a.hosts = ['h1','h2']");
    const r = await g.roQuery("MATCH (a:Agent {key:'x'}) RETURN a.hosts AS h");
    return r.data;
  });

  await check("return maps via collect", async () => {
    const r = await g.roQuery("MATCH (t:Turn) RETURN collect({k: t.key, txt: t.text})[..1] AS rows");
    return r.data;
  });

  await check("UNWIND 500 rows x 2KB", async () => {
    const big = "x".repeat(2000);
    const rows = Array.from({ length: 500 }, (_, i) => ({ key: `u${i}`, text: big, ts: i }));
    const t = Date.now();
    await g.query("UNWIND $rows AS r MERGE (t:Turn {key:r.key}) ON CREATE SET t.text = r.text, t.ts = r.ts", { params: { rows } });
    const first = Date.now() - t;
    const t2 = Date.now();
    await g.query("UNWIND $rows AS r MERGE (t:Turn {key:r.key}) ON CREATE SET t.text = r.text, t.ts = r.ts", { params: { rows } });
    return { firstMs: first, remergeMs: Date.now() - t2 };
  });

  await check("algo.pageRank", async () => {
    await g.query(`CREATE (a:F {k:'a'}), (b:F {k:'b'}), (c:F {k:'c'}), (d:F {k:'d'}),
                   (a)-[:CO]->(c), (b)-[:CO]->(c), (d)-[:CO]->(c), (c)-[:CO]->(a)`);
    const r = await g.roQuery("CALL algo.pageRank('F','CO') YIELD node, score RETURN node.k AS k, score ORDER BY score DESC");
    return r.data;
  });

  await check("algo.WCC", async () => {
    const r = await g.roQuery("CALL algo.WCC({nodeLabels:['F'], relationshipTypes:['CO']}) YIELD node, componentId RETURN node.k AS k, componentId");
    return r.data;
  });

  await check("algo.labelPropagation / CDLP", async () => {
    const r = await g.roQuery("CALL algo.labelPropagation({nodeLabels:['F'], relationshipTypes:['CO']}) YIELD node, communityId RETURN node.k AS k, communityId");
    return r.data;
  });

  await check("algo.betweenness", async () => {
    const r = await g.roQuery("CALL algo.betweenness({nodeLabels:['F'], relationshipTypes:['CO']}) YIELD node, score RETURN node.k AS k, score");
    return r.data;
  });

  await check("query TIMEOUT option", async () => {
    const r = await g.roQuery("MATCH (n) RETURN count(n) AS c", { TIMEOUT: 2000 });
    return r.data;
  });

  await check("procedures list (algo.*)", async () => {
    const r = await g.roQuery("CALL dbms.procedures() YIELD name RETURN name");
    return r.data.map((x) => x.name).filter((n) => n.startsWith("algo.") || n.startsWith("db.idx"));
  });

  await g.delete();
  await db.close();

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.ms}ms)`);
    console.log("      " + JSON.stringify(r.detail).slice(0, 400));
  }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
