const bcrypt = require('bcryptjs');

const passwords = {
  cm_office:      'CMoffice@2026',
  hm_office:      'HMoffice@2026',
  dg_office:      'DGoffice@2026',
  cp_office:      'CPoffice@2026',
  admin_crime:    'AdminCrime@2026',
  crime_branch_1: 'CB1@2026',
  crime_branch_2: 'CB2@2026',
  crime_branch_3: 'CB3@2026',
  crime_branch_4: 'CB4@2026',
  crime_branch_5: 'CB5@2026',
};

Object.entries(passwords).forEach(([user, pass]) => {
  console.log(`${user}: ${bcrypt.hashSync(pass, 10)}`);
});