// PleasureAndPain v1.3.2 — pairs with custom ScriptCards (!ppmenu --charid)
// Auto-refreshes the menu by sending !ppmenu as the clicking player.
// No @{selected} in API messages. No round automation. No auto disadvantage toggles.

on('ready', () => {
  'use strict';
  const SCRIPT  = 'PleasureAndPain';
  const VERSION = '1.3.2';

  if (!state.PP) state.PP = {
    lastActionByChar: {},   // charId -> 'pleasure' | 'pain' | 'neutral'
    penalties: {}           // charId -> { wis: n, cha: n }
  };

  const whisperGM = (s)=> sendChat(SCRIPT, `/w gm ${s}`);
  const say       = (s)=> sendChat(SCRIPT, s);

  const getCharFromSelected = (msg) => {
    const sel = (msg.selected || [])[0];
    if (!sel || sel._type !== 'graphic') return null;
    const token = getObj('graphic', sel._id);
    if (!token) return null;
    const charId = token.get('represents');
    if (!charId) return null;
    return getObj('character', charId) || null;
  };

  const safeInt = (v, d=0)=> { let n = parseInt(v, 10); return isNaN(n) ? d : n; };

  const getOrCreateAttr = (charId, name, defaultVal=0) => {
    let a = findObjs({ _type:'attribute', _characterid:charId, name })[0];
    if (!a) a = createObj('attribute', { characterid: charId, name, current: defaultVal });
    return a;
  };

  const getVal = (charId, name, def=0) => {
    const a = findObjs({ _type:'attribute', _characterid:charId, name })[0];
    return a ? safeInt(a.get('current'), def) : def;
  };

  const setVal = (charId, name, val) => getOrCreateAttr(charId, name, val).set('current', val);

  const clamp = (v, min, max)=> Math.max(min, Math.min(max, v));

  const getConScore = (charId) => {
    let con = getAttrByName(charId, 'constitution');
    if (con === undefined || con === null || con === '') con = getAttrByName(charId, 'npc_constitution');
    return safeInt(con, 10);
  };
  const getConSaveMod = (charId) => {
    let mod = getAttrByName(charId, 'constitution_save_bonus');
    if (mod === undefined || mod === null || mod === '') mod = getAttrByName(charId, 'con_savemod');
    if (mod === undefined || mod === null || mod === '') mod = getAttrByName(charId, 'npc_con_save');
    if (mod === undefined || mod === null || mod === '') mod = getAttrByName(charId, 'constitution_mod');
    return safeInt(mod, 0);
  };
  const getWisScore = (charId) => safeInt(getAttrByName(charId,'wisdom'), 10);
  const getChaScore = (charId) => safeInt(getAttrByName(charId,'charisma'), 10);
  const setScore    = (charId, ability, val) => getOrCreateAttr(charId, ability, val).set('current', val);
  const maxFromCon  = (con)=> Math.floor(con/2);
  const getName     = (char) => char?.get('name') || 'Unknown';

  const ensureDisplayAttrs = (charId, lastAction='neutral') => {
    const con = getConScore(charId);
    const max = maxFromCon(con);
    getOrCreateAttr(charId, 'pp_max', max).set('current', max);
    let badge = '◆';
    if (lastAction === 'pleasure') badge = '♥';
    else if (lastAction === 'pain') badge = '✖';
    getOrCreateAttr(charId, 'pp_badge', badge).set('current', badge);
  };

  const ensureCore = (charId) => {
    getOrCreateAttr(charId, 'pleasure', 0);
    getOrCreateAttr(charId, 'pain', 0);
    getOrCreateAttr(charId, 'pp_dc', 15);
    if (!state.PP.penalties[charId]) state.PP.penalties[charId] = { wis: 0, cha: 0 };
    if (!state.PP.lastActionByChar[charId]) state.PP.lastActionByChar[charId] = 'neutral';
    ensureDisplayAttrs(charId, state.PP.lastActionByChar[charId]);
  };

  // Refresh ScriptCards menu as the player who triggered the action
  const refreshMenuAsPlayer = (playerid, charId) => {
    // Safe fallback: print a manual button too
    const btn = `[Open Pain & Pleasure Menu](!ppmenu --charid ${charId})`;
    say(btn);
    if (playerid) {
      sendChat('player|' + playerid, `!ppmenu --charid ${charId}`);
    }
  };

  const conSaveRoll = (charId, dc) => {
    const mod = getConSaveMod(charId);
    const r = randomInteger(20);
    const total = r + mod;
    return { r, mod, total, dc, success: total >= dc };
  };

  const applyPainReminder = (charId) => {
    const name = getName(getObj('character', charId));
    say(`**${name}**: _Your breath hitches… all ability checks and attack rolls are at **disadvantage** until the end of your next turn._`);
  };

  const applyPleasureOverflow = (charId) => {
    const name = getName(getObj('character', charId));
    say(`**${name}**: _You shudder, overcome—**Stunned** until the end of your next turn._`);
    const p = getVal(charId, 'pleasure', 0);
    const halved = Math.floor(p/2);
    setVal(charId, 'pleasure', halved);
  };

  const applyPainOverflow = (charId) => {
    applyPainReminder(charId);
    const wis = getWisScore(charId);
    const cha = getChaScore(charId);
    const newWis = clamp(wis - 1, 1, 30);
    const newCha = clamp(cha - 1, 1, 30);
    setScore(charId, 'wisdom', newWis);
    setScore(charId, 'charisma', newCha);
    const pen = state.PP.penalties[charId] || (state.PP.penalties[charId]={wis:0,cha:0});
    pen.wis += (wis > 1 ? 1 : 0);
    pen.cha += (cha > 1 ? 1 : 0);
    say(`_Your poise slips a notch: **WIS –1**, **CHA –1** (to a minimum of 1)._`);
  };

  const doAdd = (msg, charId, pool, amt) => {
    ensureCore(charId);
    const con = getConScore(charId);
    const max = maxFromCon(con);
    const dc  = getVal(charId, 'pp_dc', 15);
    const cur = getVal(charId, pool, 0);
    const after = cur + amt;

    state.PP.lastActionByChar[charId] = (pool === 'pleasure' ? 'pleasure' : 'pain');
    ensureDisplayAttrs(charId, state.PP.lastActionByChar[charId]);

    if (after <= max) {
      setVal(charId, pool, after);
      if (pool === 'pain') applyPainReminder(charId);
      refreshMenuAsPlayer(msg.playerid, charId);
      return;
    }

    const roll = conSaveRoll(charId, dc);
    say(`**CON Save**: rolled **${roll.r}** ${roll.mod>=0?'+':''}${roll.mod} = **${roll.total}** vs DC **${dc}** → **${roll.success ? 'Success' : 'Fail'}**`);

    if (roll.success) {
      setVal(charId, pool, max);
      setVal(charId, 'pp_dc', dc + 1);
      if (pool === 'pain') applyPainReminder(charId);
    } else {
      if (pool === 'pleasure') applyPleasureOverflow(charId);
      else applyPainOverflow(charId);
    }
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  const doFade = (msg, charId, which, amt) => {
    ensureCore(charId);
    const pool = which.toLowerCase() === 'pleasure' ? 'pleasure' : 'pain';
    const cur  = getVal(charId, pool, 0);
    const next = clamp(cur - amt, 0, 999);
    setVal(charId, pool, next);
    state.PP.lastActionByChar[charId] = 'neutral';
    ensureDisplayAttrs(charId, 'neutral');
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  const doResetDC = (msg, charId) => {
    ensureCore(charId);
    setVal(charId, 'pp_dc', 15);
    state.PP.lastActionByChar[charId] = 'neutral';
    ensureDisplayAttrs(charId, 'neutral');
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  const doConSaveManual = (msg, charId) => {
    ensureCore(charId);
    const dc = getVal(charId, 'pp_dc', 15);
    const roll = conSaveRoll(charId, dc);
    say(`**Manual CON Save**: rolled **${roll.r}** ${roll.mod>=0?'+':''}${roll.mod} = **${roll.total}** vs DC **${dc}** → **${roll.success ? 'Success' : 'Fail'}**`);
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  const doStatus = (msg, charId) => {
    ensureCore(charId);
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  const doRecoverComposure = (msg, charId) => {
    const pen = state.PP.penalties[charId] || {wis:0,cha:0};
    if (pen.wis || pen.cha) {
      const curW = getWisScore(charId), curC = getChaScore(charId);
      setScore(charId, 'wisdom',  curW + pen.wis);
      setScore(charId, 'charisma', curC + pen.cha);
      state.PP.penalties[charId] = { wis:0, cha:0 };
      say(`_You compose yourself. Any accumulated **WIS/CHA** penalties are cleared._`);
    } else {
      say(`_You're already perfectly composed._`);
    }
    refreshMenuAsPlayer(msg.playerid, charId);
  };

  // ---------- command router ----------
  on('chat:message', (msg) => {
    if (msg.type !== 'api' || !msg.content) return;
    const parts = msg.content.trim().split(/\s+/);
    const cmd   = parts[0];

    if (cmd !== '!pp') return;

    const char = getCharFromSelected(msg);
    if (!char) { whisperGM('Select a token linked to a character.'); return; }
    const charId = char.id;
    ensureCore(charId);

    const sub = (parts[1] || '').toLowerCase();

    if (sub === 'menu')             { refreshMenuAsPlayer(msg.playerid, charId); return; }
    if (sub === 'add') {
      const which = (parts[2] || '').toLowerCase();
      const amt   = safeInt(parts[3] || 0, 0);
      if (!which || !amt) { whisperGM('Usage: !pp add pleasure|pain X'); return; }
      doAdd(msg, charId, which, amt); return;
    }

    if (sub === 'fade') {
      const rest      = msg.content.replace(/^!pp\s+fade\s*/i, '');
      const partsFade = rest.split('|');
      const which = (partsFade[0] || '').trim().toLowerCase();
      const amt   = safeInt((partsFade[1] || '').trim(), 1);
      if (!which || isNaN(amt)) { whisperGM('Usage: !pp fade <Pool>|<Amount>'); return; }
      doFade(msg, charId, which, amt); return;
    }

    if (sub === 'resetdc')          { doResetDC(msg, charId); return; }
    if (sub === 'consave')          { doConSaveManual(msg, charId); return; }
    if (sub === 'status')           { doStatus(msg, charId); return; }
    if (sub === 'recover')          { doRecoverComposure(msg, charId); return; }

    whisperGM(`Commands:
!pp menu
!pp add pleasure X
!pp add pain X
!pp fade <Pool>|<Amount>
!pp resetdc
!pp consave
!pp status
!pp recover`);
  });

  log(`${SCRIPT} v${VERSION} ready.`);
});
