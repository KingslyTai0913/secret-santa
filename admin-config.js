// Admin password for the organiser pages. Only a salted fingerprint is stored here, never the password.
// To change it:  node -e "const S=require('./santa-core.js');const s='admin-'+S.newId();console.log(s, S.hashPin('NEW-PASSWORD', s))"
// then put the two printed values below. Set to null to turn the password off.
window.SANTA_ADMIN = { salt: 'admin-5bsrwg1vj0slp', hash: '1iu440arj9o' };
