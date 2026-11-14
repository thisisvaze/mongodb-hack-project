// The "home" seed space from db/setup.js, and memories like the mock server's.
export const home = () => ({
  _id: 'home',
  name: 'Home',
  mode: 'shared_space',
  owner_id: 'u_resident',
  members: [
    { id: 'u_resident', name: 'Resident', role: 'resident' },
    { id: 'u_caregiver', name: 'Caregiver', role: 'caregiver' },
    { id: 'u_visitor', name: 'Visitor', role: 'visitor' },
  ],
  rules: {
    roles: {
      resident: { can_see: ['*'] },
      caregiver: { can_see: ['care', 'supplies', 'house_guide'] },
      visitor: { can_see: ['house_guide'] },
    },
    topics: {
      medication: { group: 'care', keep_for: '30d' },
      supplies: { group: 'supplies', keep_for: null },
      valuables: { group: 'resident_only', keep_for: null },
      documents: { group: 'resident_only', keep_for: null },
      house_guide: { group: 'house_guide', keep_for: null },
      hazard: { group: 'house_guide', keep_for: '2h' },
    },
    default_group: 'resident_only',
  },
});

const memory = (id, owner_id, item, group, extra = {}) => ({
  _id: id,
  space_id: 'home',
  owner_id,
  item,
  item_key: item.replace(/ /g, '_'),
  summary: `${item} summary`,
  group,
  status: 'active',
  ...extra,
});

export const keys = memory('m_04', 'u_resident', 'house keys', 'resident_only');
export const pills = memory('m_03', 'u_caregiver', 'evening pills', 'care');
export const batteries = memory('m_02', 'u_caregiver', 'spare batteries', 'supplies');
export const bathroom = memory('m_01', 'u_resident', 'bathroom', 'house_guide');
export const visitorCoat = memory('m_05', 'u_visitor', 'visitor coat', 'resident_only');
export const all = [keys, pills, batteries, bathroom, visitorCoat];
