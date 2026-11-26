//! Nothing the app starts may outlive it: not the shells in its terminals, the agents running in
//! them, or the CAD engine.
//!
//! A clean quit closes them itself (`Terminals::close_all`). This module covers everything else:
//! a crash, the process being killed, or `tauri dev` restarting the app after a code change.
//!
//! On Windows the app puts itself in a job object that kills every process in it when the job's
//! last handle closes. Child processes join their parent's job automatically, so every
//! descendant is in it. The handle is never closed on purpose: Windows closes it when the app's
//! process ends, however it ends, and that ends the whole tree.
//!
//! The trade-off: a program started from a Cadorphin terminal also closes with the app, even a
//! GUI program such as an editor. That is the same as closing any terminal window.

#[cfg(windows)]
pub fn kill_children_with_app() {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: plain Win32 calls on a job handle created here; `info` is a zeroed, correctly sized
    // struct that outlives the call that reads it.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("cadorphin: could not create a job object; terminals may outlive a crash");
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!("cadorphin: could not join a job object; terminals may outlive a crash");
        }
        // `job` is intentionally leaked; see the module docs.
    }
}

/// Elsewhere a clean quit still closes every terminal. A crash or kill can leave shells running
/// on macOS and Linux for now.
#[cfg(not(windows))]
pub fn kill_children_with_app() {}
