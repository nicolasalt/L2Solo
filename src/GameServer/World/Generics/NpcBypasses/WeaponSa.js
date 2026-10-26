const Service = invoke('GameServer/Items/WeaponSAService');
module.exports = async function weaponSA(session, parts) {
    try {
        if (parts[1] === 'apply' && parts.length === 3) {
            const result = await Service.exchange(session, parts[2]);
            Service.menu(session, result.operation, 0, `Special ability ${result.operation === 'install' ? 'installed' : 'removed'}. Enchantment +${result.weapon.enchant} preserved.`);
        } else if (parts[1] === 'preview' && parts.length === 4) Service.preview(session, Number(parts[2]), parts[3]);
        else if (parts[1] === 'menu' && parts.length <= 4) Service.menu(session, parts[2], parts[3]);
        else throw Error('Unknown weapon service.');
    } catch (error) {
        const Response = invoke('GameServer/Network/Response');
        session.dataSendToMe(Response.actionFailed());
        try { Service.menu(session, 'install', 0, 'Exchange unavailable. Check your materials, unequip the weapon and select it again.'); }
        catch (_) {
            // The smith cannot even show its menu: say why instead of nothing.
            const objectId = session.activeNpcTalk?.objectId;
            if (objectId) session.dataSendToMe(Response.npcHtml(objectId, `<html><body>${String(error.message).replace(/[<>&]/g, '')}</body></html>`));
        }
        utils.infoWarn('WeaponSA', 'exchange rejected: %s', error.message);
    }
};
