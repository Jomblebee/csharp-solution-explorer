using Microsoft.EntityFrameworkCore;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using TaskFlow.Application.Tasks.Commands.DeleteTask;
using TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;
using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Enums;
using TaskFlow.Domain.Exceptions;
using TaskFlow.Infrastructure.Persistence;

namespace TaskFlow.Tests.MSTest;

[TestClass]
public class TaskTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    private static async Task<int> SeedTaskAsync(TaskFlowDbContext context)
    {
        var task = new AppTask { Title = "Seed task" };
        context.Tasks.Add(task);
        await context.SaveChangesAsync();
        return task.Id;
    }

    [TestMethod]
    public async Task UpdateStatus_ExistingTask_UpdatesStatus()
    {
        await using var context = CreateContext(nameof(UpdateStatus_ExistingTask_UpdatesStatus));
        var id = await SeedTaskAsync(context);
        var handler = new UpdateTaskStatusCommandHandler(context);

        await handler.Handle(new UpdateTaskStatusCommand(id, AppTaskStatus.InProgress), default);

        var task = await context.Tasks.FindAsync(id);
        Assert.IsNotNull(task);
        Assert.AreEqual(AppTaskStatus.InProgress, task.Status);
    }

    [TestMethod]
    public async Task UpdateStatus_MissingTask_ThrowsDomainException()
    {
        await using var context = CreateContext(nameof(UpdateStatus_MissingTask_ThrowsDomainException));
        var handler = new UpdateTaskStatusCommandHandler(context);

        await Assert.ThrowsExactlyAsync<DomainException>(() =>
            handler.Handle(new UpdateTaskStatusCommand(999, AppTaskStatus.Done), default));
    }

    [TestMethod]
    public async Task Delete_ExistingTask_RemovesTask()
    {
        await using var context = CreateContext(nameof(Delete_ExistingTask_RemovesTask));
        var id = await SeedTaskAsync(context);
        var handler = new DeleteTaskCommandHandler(context);

        await handler.Handle(new DeleteTaskCommand(id), default);

        Assert.IsNull(await context.Tasks.FindAsync(id));
    }

    // Data-driven: grouped under one method in the Test Explorer.
    [TestMethod]
    [DataRow(AppTaskStatus.Todo)]
    [DataRow(AppTaskStatus.InProgress)]
    [DataRow(AppTaskStatus.Done)]
    public async Task UpdateStatus_VariousStatuses_SetsStatus(AppTaskStatus target)
    {
        await using var context = CreateContext($"{nameof(UpdateStatus_VariousStatuses_SetsStatus)}_{target}");
        var id = await SeedTaskAsync(context);
        var handler = new UpdateTaskStatusCommandHandler(context);

        await handler.Handle(new UpdateTaskStatusCommand(id, target), default);

        var task = await context.Tasks.FindAsync(id);
        Assert.IsNotNull(task);
        Assert.AreEqual(target, task.Status);
    }

    // Demonstrates the skipped (yellow) state in the Test Explorer.
    [TestMethod]
    [Ignore("Demo: shows the skipped state in the Test Explorer.")]
    public void Skipped_Demo()
    {
        Assert.Fail();
    }

    // Deliberately failing: demonstrates the red state plus message rendering.
    [TestMethod]
    public void Intentional_Failure_ForExplorerRedState()
    {
        Assert.AreEqual(42, 40 + 1);
    }
}
