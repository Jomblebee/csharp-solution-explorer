using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Projects.Commands.CreateProject;
using TaskFlow.Domain.Exceptions;
using TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;
using TaskFlow.Domain.Enums;
using TaskFlow.Infrastructure.Persistence;
using TUnit.Assertions;
using TUnit.Assertions.Extensions;
using TUnit.Core;

namespace TaskFlow.Tests.TUnit;

public class ProjectTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Test]
    public async Task CreateProject_ReturnsId()
    {
        await using var context = CreateContext(nameof(CreateProject_ReturnsId));
        var handler = new CreateProjectCommandHandler(context);

        var id = await handler.Handle(new CreateProjectCommand("My project", null), default);

        await Assert.That(id).IsGreaterThan(0);
        await Assert.That(await context.Projects.FindAsync(id)).IsNotNull();
    }

    // Data-driven: grouped under one method in the Test Explorer.
    [Test]
    [Arguments("Alpha")]
    [Arguments("Beta")]
    public async Task CreateProject_PersistsName(string name)
    {
        await using var context = CreateContext($"{nameof(CreateProject_PersistsName)}_{name}");
        var handler = new CreateProjectCommandHandler(context);

        var id = await handler.Handle(new CreateProjectCommand(name, null), default);

        var project = await context.Projects.FindAsync(id);
        await Assert.That(project).IsNotNull();
        await Assert.That(project!.Name).IsEqualTo(name);
    }

    [Test]
    public async Task UpdateStatus_MissingTask_ThrowsDomainException()
    {
        await using var context = CreateContext(nameof(UpdateStatus_MissingTask_ThrowsDomainException));
        var handler = new UpdateTaskStatusCommandHandler(context);

        await Assert.That(async () =>
                await handler.Handle(new UpdateTaskStatusCommand(999, AppTaskStatus.Done), default))
            .Throws<DomainException>();
    }

    // Demonstrates the skipped (yellow) state in the Test Explorer.
    [Test]
    [Skip("Demo: shows the skipped state in the Test Explorer.")]
    public async Task Skipped_Demo()
    {
        await Assert.That(true).IsFalse();
    }

    // Deliberately failing: demonstrates the red state plus message rendering.
    [Test]
    public async Task Intentional_Failure_ForExplorerRedState()
    {
        await Assert.That(40 + 1).IsEqualTo(42);
    }
}
