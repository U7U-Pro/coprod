// coprod: MTS-ESP (microtuning shared by a host application) has no browser
// equivalent, so the client reports "no master" and the engine falls back to
// its own tuning table.
#pragma once
struct MTSClient;
inline bool MTS_HasMaster(const MTSClient *) { return false; }
inline double MTS_NoteToFrequency(const MTSClient *, int, int) { return 440.0; }
