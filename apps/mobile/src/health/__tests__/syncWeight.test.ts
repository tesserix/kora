import { syncWeight } from "../syncWeight";

const sample = (id: string, kg: number) => ({
  uuid: id, quantity: kg, startDate: new Date("2026-08-23T07:00:00Z"), sourceName: "Withings",
});

// The anchor is what makes a failed sync self-healing: leave it where it was
// and the next launch re-sends the same window. Advancing it on failure would
// skip those samples permanently -- there is no second chance, because an
// anchored query only ever moves forward.
test("does not advance the anchor when the post fails", async () => {
  const writeAnchor = jest.fn();
  await expect(syncWeight({
    queryWeights: async () => ({ samples: [sample("a", 70.4)], newAnchor: "anchor-2" }),
    post: async () => { throw new Error("network"); },
    readAnchor: async () => "anchor-1",
    writeAnchor,
  })).rejects.toThrow("network");
  expect(writeAnchor).not.toHaveBeenCalled();
});

test("advances the anchor once the batch is accepted", async () => {
  const writeAnchor = jest.fn();
  const result = await syncWeight({
    queryWeights: async () => ({ samples: [sample("a", 70.4)], newAnchor: "anchor-2" }),
    post: async () => ({ accepted: 1, rejected: [] }),
    readAnchor: async () => "anchor-1",
    writeAnchor,
  });
  expect(result.accepted).toBe(1);
  expect(writeAnchor).toHaveBeenCalledWith("weight", "anchor-2");
});

test("posts nothing and still advances when there are no new samples", async () => {
  const post = jest.fn();
  const writeAnchor = jest.fn();
  await syncWeight({
    queryWeights: async () => ({ samples: [], newAnchor: "anchor-2" }),
    post, readAnchor: async () => "anchor-1", writeAnchor,
  });
  expect(post).not.toHaveBeenCalled();
  expect(writeAnchor).toHaveBeenCalledWith("weight", "anchor-2");
});
