// CloudFront Function (viewer request) on the /_e behaviour of both distributions: answers the game's anonymous usage
// beacons with 204 at the edge. Nothing is stored here; the event lives in the query string of the access log line
// (see tools/analytics/report.py). Created once with the AWS CLI; attached by tools/analytics/setup.py.
function handler(event) {
  return {
    statusCode: 204,
    statusDescription: 'No Content',
    headers: { 'cache-control': { value: 'no-store' } },
  };
}
