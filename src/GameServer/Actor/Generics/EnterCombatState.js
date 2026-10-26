const ServerResponse = invoke('GameServer/Network/Response');

// C4 combat stance ends 15 s after the last hit taken (AttackStanceTaskManager).
// Without the timeout a tank whose kills go to the party stayed "in combat"
// forever and every smith, Mammon and station service refused it.
const COMBAT_STANCE_MS = 15000;

function enterCombatState(session, actor) {
    clearTimeout(actor.combatStanceTimer);
    actor.combatStanceTimer = setTimeout(() => {
        actor.combatStanceTimer = undefined;
        if (!actor.state.fetchCombats()) return;
        if (actor.state.fetchHits() || actor.state.fetchCasts()) return enterCombatState(session, actor);
        actor.state.setCombats(false);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStop(actor.fetchId()), actor);
    }, COMBAT_STANCE_MS);
    actor.combatStanceTimer.unref?.();

    if (actor.state.fetchCombats()) {
        return;
    }

    actor.state.setCombats(true);
    session.dataSendToMeAndOthers(ServerResponse.autoAttackStart(actor.fetchId()), actor);
}

enterCombatState.COMBAT_STANCE_MS = COMBAT_STANCE_MS;
module.exports = enterCombatState;
