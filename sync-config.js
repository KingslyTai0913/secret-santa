// Firebase project that records only WHO has already drawn (person numbers), so their names
// disappear from everyone's list. No names or results are ever sent there.
// Set to null to run without it: names then only disappear on the phone that drew them.
// (A Firebase web API key is public by design; firestore.rules limits what it can do.)
window.SANTA_SYNC = { projectId: 'family-secret-santa-939c8', apiKey: 'AIzaSyDp-3YvzYd16xhiUwnZztBaOY5tbd97feU' };
